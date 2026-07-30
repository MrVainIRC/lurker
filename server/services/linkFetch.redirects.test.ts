// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Redirect following, at a real origin.
//
// This is its own file because it needs the address policy INVERTED: the real guard blocks
// loopback, correctly and on purpose, which means no test can ever watch `safeRequest` complete
// a hop against a server it just started. So the guard is swapped for a test policy — allow
// 127.0.0.1, refuse everything else — and the mechanism runs for real over real sockets.
//
// ⚠ What's mocked is the POLICY, never the mechanism. `normalizeUrl`, the redirect loop, the
// per-hop re-validation and the pinned lookup are all the shipping code. The policy itself is
// tested against the real implementation in ../utils/ipGuard.test.ts, and that this module
// consults it is tested against the real implementation in ./linkFetch.test.ts. Neither of
// those can reach a live origin; this one can't judge a real address. Together they cover it.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const { safeRequest, bufferStream } = await import('./linkFetch.js');

/** A hop. Returns the response to send, given the request. */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let handler: Handler;
let hits: string[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url || '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(h: Handler) {
  hits = [];
  handler = h;
}

function redirectTo(location: string, status = 302): Handler {
  return (req, res) => {
    if (req.url?.endsWith('/end')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<head><title>ARRIVED</title></head>');
      return;
    }
    res.writeHead(status, { location });
    res.end('ignore me');
  };
}

describe('safeRequest — following redirects', () => {
  it('follows a hop and reports the URL it ENDED at', async () => {
    // `finalUrl` is the base for resolving a relative og:image, so a stale one silently points
    // metadata at the wrong host.
    reset(redirectTo('/end'));
    const res = await safeRequest(new URL(`${base}/start`));
    const body = await bufferStream(res, { maxBytes: 4096 });
    expect(body.body.toString()).toContain('ARRIVED');
    expect(body.finalUrl.toString()).toBe(`${base}/end`);
    expect(hits).toEqual(['/start', '/end']);
  });

  it('resolves a relative Location against the hop that sent it', async () => {
    reset(redirectTo('end'));
    const res = await safeRequest(new URL(`${base}/a/b`));
    expect(res.finalUrl.toString()).toBe(`${base}/a/end`);
    res.stream.destroy();
  });

  it('re-vets every hop, so a redirect into internal space is refused', async () => {
    // ⚠⚠ The way this bug actually ships. The entry URL passes review — it's an ordinary
    // public page — and the origin answers 302 to the cloud metadata endpoint. Only a check
    // on the TARGET of each hop catches it.
    for (const evil of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'file:///etc/passwd',
      'https://user:pass@example.com/', // credentials a further hop would carry onward
    ]) {
      reset(redirectTo(evil));
      await expect(safeRequest(new URL(`${base}/start`))).rejects.toThrow(/disallowed target/);
      expect(hits).toEqual(['/start']);
    }
  });

  it('treats every 3xx that carries a Location the same way', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      reset(redirectTo('http://169.254.169.254/', status));
      await expect(safeRequest(new URL(`${base}/start`))).rejects.toThrow(/disallowed target/);
    }
  });

  it('gives up rather than following a redirect loop', async () => {
    reset(redirectTo('/loop'));
    await expect(safeRequest(new URL(`${base}/loop`))).rejects.toThrow(/too many redirects/);
    // Four requests: the entry plus MAX_REDIRECTS hops, and then it stops.
    expect(hits.length).toBe(4);
  });

  it('DESTROYS a redirect body instead of draining it', async () => {
    // ⚠ Regression guard, and a resource one rather than a correctness one: draining calls
    // `resume()`, which reads the entire body — and a hostile origin can answer 302 with a
    // gigabyte, on every hop, none of it covered by any byte cap. Draining only exists to
    // return a socket to the pool, and keep-alive is off on both agents.
    //
    // The proof is server-side: this response is never ended, so the connection can only close
    // because the client tore it down. A drained-and-abandoned socket stays open and this test
    // times out.
    let finished: boolean | null = null;
    const closed = new Promise<void>((resolve) => {
      reset((_req, res) => {
        res.on('error', () => {});
        res.on('close', () => {
          finished = res.writableFinished;
          resolve();
        });
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        res.write('a body we should never read');
        // deliberately no res.end()
      });
    });

    await expect(safeRequest(new URL(`${base}/start`))).rejects.toThrow(/disallowed target/);
    await closed;
    expect(finished).toBe(false);
  });
});
