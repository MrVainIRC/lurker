// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeUrl, userAgent, bufferStream, safeRequest } from './linkFetch.js';

// The address guard itself is tested in ../utils/ipGuard.test.ts. What this file tests is that
// this module consults it — on parse, on connect, and on every redirect hop.

describe('normalizeUrl', () => {
  it('accepts ordinary http and https URLs', () => {
    expect(normalizeUrl('https://example.com/a')?.toString()).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com/a')?.toString()).toBe('http://example.com/a');
  });

  it('rejects schemes that have no business being fetched', () => {
    for (const raw of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'ftp://example.com/x',
      'data:text/html,<script>',
      'javascript:alert(1)',
      'not a url at all',
    ]) {
      expect(normalizeUrl(raw)).toBeNull();
    }
  });

  it('rejects embedded credentials, which a redirect would carry onward', () => {
    expect(normalizeUrl('https://user:pass@example.com/')).toBeNull();
    expect(normalizeUrl('https://user@example.com/')).toBeNull();
  });

  it('rejects hosts that are literally an internal address', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
      // The mapped forms, through the real parser this time.
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:10.0.0.5]:8015/',
    ]) {
      expect(normalizeUrl(raw)).toBeNull();
    }
  });

  it('allows a public IP literal', () => {
    expect(normalizeUrl('http://8.8.8.8/')).not.toBeNull();
  });

  it('drops the fragment so #a and #b share one cache entry', () => {
    expect(normalizeUrl('https://example.com/p#section')?.toString()).toBe('https://example.com/p');
  });

  it('leaves hostnames to be judged at connect time, not parse time', () => {
    // A name that resolves internally must still PARSE — the guard that catches
    // it is the pinned lookup, because only that one can't be raced by DNS.
    expect(normalizeUrl('http://localhost.example.com/')).not.toBeNull();
  });
});

/** A live origin on loopback plus a probe that proves it's serving. */
async function reachableOrigin(secret: string) {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<head><meta property="og:title" content="${secret}"></head>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits: () => hits,
    /** Fetch it for real, over the shared global agent, and return the body. */
    probe: (url: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get(url, (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => resolve(body));
          })
          .on('error', reject);
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('safeRequest refuses an internal origin that is genuinely reachable', () => {
  // ⚠ A test asserting only "the fetch failed" would pass for the wrong reason — an unreachable
  // URL fails too. So stand up a real server, PROVE it answers, and only then prove we won't
  // touch it. The request counter is the assertion: not "it errored" but "nothing arrived".

  it('refuses an address literal, which node would dial without any DNS at all', async () => {
    // The parse-time guard is the ONLY one on this path: `net.isIP` matches, so node connects
    // straight to the address and `pinnedLookup` never runs.
    const origin = await reachableOrigin('INTERNAL SECRET');
    try {
      const target = `http://127.0.0.1:${origin.port}/admin`;
      expect(await origin.probe(target)).toContain('INTERNAL SECRET');
      expect(origin.hits()).toBe(1);

      expect(normalizeUrl(target)).toBeNull();
      // And again through safeRequest, since a caller that skipped normalizeUrl must not be
      // able to turn this module into an open proxy.
      await expect(safeRequest(new URL(target))).rejects.toThrow(/disallowed/);

      expect(origin.hits()).toBe(1); // the probe's own request, and nothing of ours
    } finally {
      await origin.close();
    }
  });

  it('refuses a HOSTNAME that resolves internally', async () => {
    // A distinct code path, and the one DNS rebinding attacks: `localhost` parses perfectly
    // well and is caught only when the pinned lookup sees what it resolved to.
    //
    // The probe runs first on purpose. It uses `http.globalAgent`, which is keep-alive by
    // default, so by the time we call safeRequest there is a warm socket to this exact origin
    // sitting in the shared pool. If this module ever went back to the global agent, that
    // socket would be reused, no DNS would happen, and the pin would be bypassed — which is
    // how the bug was found in the first place.
    const origin = await reachableOrigin('VIA HOSTNAME');
    try {
      const target = `http://localhost:${origin.port}/`;
      expect(await origin.probe(target)).toContain('VIA HOSTNAME');
      expect(origin.hits()).toBe(1);

      expect(normalizeUrl(target)).not.toBeNull(); // parses fine; that's the point
      await expect(safeRequest(new URL(target))).rejects.toThrow(/internal addresses/);

      expect(origin.hits()).toBe(1);
    } finally {
      await origin.close();
    }
  });
});

describe('userAgent', () => {
  it('identifies as Lurker and as a preview fetcher, with a contact URL', () => {
    const ua = userAgent();
    expect(ua).toContain('Lurker');
    expect(ua).toContain('+https://');
    expect(ua).toContain('facebookexternalhit');
  });

  it('carries the real app version rather than a hardcoded one', async () => {
    const { APP_VERSION } = await import('../utils/userAgent.js');
    expect(userAgent()).toContain(APP_VERSION);
  });

  it('is overridable by the operator', () => {
    const saved = process.env.LURKER_PREVIEW_USER_AGENT;
    process.env.LURKER_PREVIEW_USER_AGENT = 'CustomAgent/9';
    try {
      expect(userAgent()).toBe('CustomAgent/9');
    } finally {
      if (saved === undefined) delete process.env.LURKER_PREVIEW_USER_AGENT;
      else process.env.LURKER_PREVIEW_USER_AGENT = saved;
    }
  });
});

/**
 * A RawResponse delivering exactly these chunks.
 *
 * The chunking is load-bearing in several tests below: the head scan carries state across
 * chunk boundaries, and `destroy()` doesn't stop ones already queued.
 */
function fakeChunks(parts: string[], headers: Record<string, string> = {}) {
  return {
    status: 200,
    headers: headers as never,
    contentType: 'text/html',
    finalUrl: new URL('https://example.com/'),
    stream: Readable.from(parts.map((p) => Buffer.from(p, 'utf8'))) as never,
  };
}

/** The same, as a single chunk. */
function fake(body: string | Buffer, headers: Record<string, string> = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return { ...fakeChunks([], headers), stream: Readable.from([buf]) as never };
}

describe('bufferStream', () => {
  // The SSRF guard blocks loopback (correctly), so a real local origin can't be used here —
  // and this is a pure stream-consumption question anyway.

  it('reads a whole small body', async () => {
    const res = await bufferStream(fake('hello'), { maxBytes: 1000 });
    expect(res.body.toString()).toBe('hello');
    expect(res.truncated).toBe(false);
  });

  it('truncates at the cap and says so', async () => {
    const res = await bufferStream(fake('x'.repeat(500)), { maxBytes: 100 });
    expect(res.body.length).toBe(100);
    expect(res.truncated).toBe(true);
  });

  it('reads a PREFIX of an oversized body rather than refusing it', async () => {
    // ⚠ Regression guard. An earlier version threw on a Content-Length over the cap, which
    // broke two things at once: Wikipedia (a 572 KB article) got NO preview at all, and
    // image dimensions failed for every image over the 64 KB header read — i.e. most of
    // them. `maxBytes` means "read at most this much", never "refuse anything bigger".
    const res = await bufferStream(fake('y'.repeat(5000), { 'content-length': '5000' }), {
      maxBytes: 100,
    });
    expect(res.body.length).toBe(100);
    expect(res.truncated).toBe(true);
  });

  it('stops once the head closes, so a long document costs only its head', async () => {
    const html = `<html><head><title>T</title></head><body>${'z'.repeat(100_000)}</body></html>`;
    const res = await bufferStream(fake(html), { maxBytes: 512 * 1024, stopAtHeadEnd: true });
    expect(res.body.length).toBeLessThan(1000);
    expect(res.body.toString()).toContain('<title>T</title>');
    // Stopping early on purpose is not truncation — we got everything we wanted.
    expect(res.truncated).toBe(false);
  });

  it('finds a </head> split across chunk boundaries', async () => {
    const res = await bufferStream(
      fakeChunks(['<head><title>T</title></he', 'ad><body>tail</body>']),
      { maxBytes: 512 * 1024, stopAtHeadEnd: true },
    );
    expect(res.body.toString()).toContain('<title>T</title>');
    expect(res.body.toString()).not.toContain('tail');
  });

  it('finds a </head> dribbled out one byte at a time', async () => {
    // ⚠ Regression guard. The carried-over window used to be "the previous chunk", which
    // spans the needle only when chunks are longer than it is. With small chunks the tag was
    // missed entirely — and worse, the offset arithmetic assumed an overlap it hadn't been
    // given, so a match found just after a short chunk trimmed bytes off the end of the head.
    const doc = '<head><title>T</title></head><body>tail</body>';
    const res = await bufferStream(fakeChunks([...doc]), {
      maxBytes: 512 * 1024,
      stopAtHeadEnd: true,
    });
    expect(res.body.toString()).toBe('<head><title>T</title>');
  });

  it('cuts exactly at the tag when the head ends mid-chunk', async () => {
    const res = await bufferStream(fakeChunks(['<head><title>T</title>', '</head><body>tail']), {
      maxBytes: 512 * 1024,
      stopAtHeadEnd: true,
    });
    expect(res.body.toString()).toBe('<head><title>T</title>');
  });

  it('reads to the end when a document has no head at all', async () => {
    const res = await bufferStream(fake('just text, no tags'), {
      maxBytes: 1000,
      stopAtHeadEnd: true,
    });
    expect(res.body.toString()).toBe('just text, no tags');
  });

  it('refuses a body it cannot measure', async () => {
    // We ask for identity precisely so the byte counter means something; a compressed
    // response would let a small payload expand into something enormous.
    await expect(
      bufferStream(fake('...', { 'content-encoding': 'gzip' }), { maxBytes: 1000 }),
    ).rejects.toThrow(/content-encoding/);
  });
});
