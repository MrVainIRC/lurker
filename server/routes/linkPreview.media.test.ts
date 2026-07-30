// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The byte proxy against a real origin.
//
// Its own file because it needs the address policy inverted — the real guard blocks loopback,
// correctly, so nothing can watch this endpoint actually SERVE without it. The main route test
// keeps the real guard and covers refusal; this one covers what happens when a fetch succeeds,
// which was untested end to end: the headers, the caps, the range plumbing.
//
// ⚠ What's mocked is the POLICY, never the mechanism. Express, the token, the throttles, the
// pool, safeRequest, the pinned lookup and the pipe are all shipping code.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const ctx = setupTestDb('routes-link-preview-media');
process.env.LURKER_LINK_PREVIEWS = 'on';

let app: Express;
let agent: LurkerTestAgent;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let base: string;

/** A token for a path on the live origin, reached through `localhost` so the pinned lookup runs. */
const tokenFor = (path: string): string => mintProxyToken(`${base}${path}`);

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-media');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);

  origin = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(origin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  ctx.cleanup();
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('serving bytes', () => {
  it('streams an image back under our own origin, with the hardening headers', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    };

    const res = await agent.get(`/api/link-preview/media/${tokenFor('/a.png')}`).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('private, max-age=86400, immutable');
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('refuses SVG even though the origin calls it an image', async () => {
    // The allowlist is the point: these bytes are served under OUR origin, and SVG executes
    // script. One definition now — the route asks the resolver's `proxyableContentType`.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/logo.svg')}`);
    expect(res.status).toBe(404);
  });

  it('refuses text/html, which is the other way to get script into our origin', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>alert(1)</script>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/page.html')}`);
    expect(res.status).toBe(404);
  });

  it('does not claim to accept ranges when the origin ignored them', async () => {
    // ⚠ Advertising `Accept-Ranges: bytes` for a source that ignores Range makes a media
    // element seek by asking for a range and then silently receive the whole file from byte
    // zero — a seek that jumps back to the start.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/b.png')}`).expect(200);
    expect(res.headers['accept-ranges']).toBeUndefined();
  });

  it('forwards a range, and says so, when the origin honours one', async () => {
    handler = (req, res) => {
      if (!req.headers.range) {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('whole');
        return;
      }
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes 0-4/1000`,
        'content-length': '5',
      });
      res.end('parti');
    };

    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/clip.mp4')}`)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(res.headers['content-range']).toBe('bytes 0-4/1000');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('refuses a partial response whose RESOURCE is over the cap', async () => {
    // ⚠⚠ Regression guard. The cap only ever looked at Content-Length, which on a 206 is the
    // length of the PART — so a client asking for a 1 GB file one megabyte at a time satisfied
    // `declared <= cap` every single time and walked straight past a limit named for the
    // resource. The real size is the figure after the slash in Content-Range.
    handler = (_req, res) => {
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes 0-1023/${1024 * 1024 * 1024}`,
        'content-length': '1024',
      });
      res.end(Buffer.alloc(1024));
    };

    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/huge.mp4')}`)
      .set('Range', 'bytes=0-1023');
    expect(res.status).toBe(413);
  });

  it('refuses a whole response that declares itself over the cap', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(64 * 1024 * 1024),
      });
      res.end(PNG);
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/huge.png')}`);
    expect(res.status).toBe(413);
  });

  it('passes an unsatisfiable range through as 416 rather than 404', async () => {
    // A media element knows what to do with 416 — it means "that range doesn't exist", not
    // "the file doesn't exist", and collapsing the two makes a bad seek look like a dead link.
    handler = (_req, res) => {
      res.writeHead(416, { 'content-range': 'bytes */500' });
      res.end();
    };
    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/short.mp4')}`)
      .set('Range', 'bytes=9999-')
      .expect(416);
    expect(res.headers['content-range']).toBe('bytes */500');
  });

  it('answers 404, not 500, when the origin is simply not there', async () => {
    const token = mintProxyToken('http://127.0.0.1:1/nothing.png');
    const res = await agent.get(`/api/link-preview/media/${token}`);
    expect(res.status).toBe(404);
  });

  it('survives a token whose signature is the right length in the wrong encoding', async () => {
    // ⚠ Regression guard, reached through the ROUTE because that is where it hurt: the length
    // guard compared UTF-16 code units while timingSafeEqual compares bytes, so this threw a
    // RangeError from above the handler's try — a 500 and a logged stack, where the endpoint's
    // whole answer to a bad token is 403.
    const token = tokenFor('/a.png');
    const payload = token.slice(0, token.lastIndexOf('.'));
    const sig = token.slice(token.lastIndexOf('.') + 1);
    const res = await agent.get(
      `/api/link-preview/media/${payload}.${encodeURIComponent(`é${'a'.repeat(sig.length - 1)}`)}`,
    );
    expect(res.status).toBe(403);
  });
});
