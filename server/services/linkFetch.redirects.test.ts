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
//
// ⚠⚠ Everything here goes through `localhost`, NOT `127.0.0.1`, and that is not incidental:
// node skips DNS entirely for an address literal, so a test written against the literal never
// invokes `pinnedLookup` at all. This is the only place its SUCCESS path runs — and since node
// asks for `{all: true}` by default, `callback(null, safe)` is the branch every real fetch in
// production takes. Break it and every preview fails against a fully green suite.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const { safeRequest, bufferStream, UnsafeUrlError } = await import('./linkFetch.js');

/** A hop. Returns the response to send, given the request. */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let handler: Handler;
let hits: string[] = [];
let server: http.Server;
let base: string;
/** The same origin by address literal, for the one test that wants DNS skipped. */
let literalBase: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url || '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  // `localhost` commonly resolves to ::1 as well, which the test policy above refuses — so
  // reaching this server at all also proves the lookup FILTERS rather than taking the first
  // answer node hands it.
  base = `http://localhost:${port}`;
  literalBase = `http://127.0.0.1:${port}`;
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

describe('pinnedLookup, on the path where it actually runs', () => {
  it('connects through a resolved hostname, dropping the answers the policy refuses', async () => {
    // The success path: `localhost` resolves, at least one answer survives the filter, node
    // gets handed that address and the fetch completes. Nothing else in the suite runs this —
    // the other lookup test asserts the refusal, and every literal-addressed request skips DNS.
    reset(redirectTo('/end'));
    const res = await safeRequest(new URL(`${base}/end`));
    const body = await bufferStream(res, { maxBytes: 4096 });
    expect(body.body.toString()).toContain('ARRIVED');
    expect(hits).toEqual(['/end']);
  });

  it('is skipped entirely for an address literal, so the parse guard is the only one', async () => {
    reset(redirectTo('/end'));
    const res = await safeRequest(new URL(`${literalBase}/end`));
    res.stream.destroy();
    expect(hits).toEqual(['/end']);
  });
});

describe('the Content-Type a real origin sends', () => {
  it('splits into a bare type and the declared charset', async () => {
    // ⚠ The producer half of a seam that was broken end to end. `decodeBody` used to re-parse
    // a header it was never given — callers had only `contentType`, stripped of its
    // parameters — so a page served in a non-UTF-8 encoding decoded as UTF-8 and rendered as
    // replacement characters. `decodeBody` now takes `charset`; this asserts something real
    // arrives in it, off a live response rather than a hand-built object.
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/HTML; charset="Windows-1251"' });
      res.end('<head><title>ARRIVED</title></head>');
    });
    const res = await safeRequest(new URL(`${base}/page`));
    expect(res.contentType).toBe('text/html');
    expect(res.charset).toBe('windows-1251');
    // And it survives buffering, which is the object the scraper actually holds.
    const buffered = await bufferStream(res, { maxBytes: 4096 });
    expect(buffered.charset).toBe('windows-1251');
  });

  it('reports no charset when the origin declared none', async () => {
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<head></head>');
    });
    const res = await safeRequest(new URL(`${base}/page`));
    expect(res.charset).toBeNull();
    res.stream.destroy();
  });
});

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

  it('fails CLOSED on a Location it cannot even parse', async () => {
    // ⚠ Regression guard. `new URL(location, base)` throws ERR_INVALID_URL while BUILDING
    // normalizeUrl's argument, so its own try/catch never saw it and an attacker-controlled
    // header escaped as a raw TypeError — which a caller sorting UnsafeUrlError from real
    // defects would file as a bug against us. Written straight to the socket so node's own
    // header validation can't sanitise it first.
    for (const bad of ['http://[', 'https://exa mple.com/', 'http://%zz/', 'http://:80/']) {
      reset((_req, res) => {
        res.socket?.end(`HTTP/1.1 302 Found\r\nLocation: ${bad}\r\nContent-Length: 0\r\n\r\n`);
      });
      await expect(safeRequest(new URL(`${base}/start`))).rejects.toThrow(UnsafeUrlError);
    }
  });

  it('refuses a body it cannot reason about, before anyone can pipe it', async () => {
    // ⚠ We ask for identity; an origin that gzips anyway hands back bytes we can neither size
    // nor relay. Checked in `requestOnce` rather than `bufferStream` because the byte proxy
    // never buffers — it would have streamed DEFLATE bytes to a browser under the origin's own
    // `Content-Type: image/png`, a corrupt image with no transport error to explain it.
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
      res.end('nonsense');
    });
    await expect(safeRequest(new URL(`${base}/img`))).rejects.toThrow(/content-encoding/);
  });

  it('refuses to forward a Range it cannot vouch for', async () => {
    // The value arrives from a browser via the proxy route. A CR/LF in it makes node throw
    // ERR_INVALID_CHAR out of the promise executor — node blocks the injection, so nothing is
    // smuggled, but the caller gets a TypeError where this module promises to fail closed.
    reset(redirectTo('/end'));
    for (const bad of ['bytes=0-1\r\nX-Evil: 1', 'everything', 'bytes=abc-def']) {
      await expect(safeRequest(new URL(`${base}/end`), { range: bad })).rejects.toThrow(
        UnsafeUrlError,
      );
    }
    expect(hits).toEqual([]); // refused before it dialled
    const ok = await safeRequest(new URL(`${base}/end`), { range: 'bytes=0-1023' });
    ok.stream.destroy();
    expect(hits).toEqual(['/end']);
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
