// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Two endpoints, both authenticated:
//
//   POST /api/link-preview/resolve      urls[] → descriptors[]
//   GET  /api/link-preview/media/:token → the bytes, streamed
//
// REST rather than WebSocket because these are reads, and Lurker's reads are
// REST (search is the one deliberate exception, and it's deliberate because it
// needs a token/reply round trip the REST surface can't express). The byte
// endpoint has to be a URL regardless — that's what an <img src> is.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { RequestThrottle } from '../middleware/rateLimit.js';
import {
  resolvePreview,
  toDescriptor,
  proxyableContentType,
  MAX_IMAGE_PROXY_BYTES,
  MAX_MEDIA_PROXY_BYTES,
  MAX_URLS_PER_REQUEST,
} from '../services/linkPreview.js';
import { verifyProxyToken } from '../services/mediaProxyToken.js';
import { normalizeUrl, safeRequest } from '../services/linkFetch.js';
import { previewsEnabled } from '../utils/previews.js';
import { SlotPool } from '../utils/slotPool.js';

const router = Router();
router.use(requireAuth);

/**
 * Per-account cap on resolutions.
 *
 * Keyed by user rather than by IP, unlike the auth limiters: this route is
 * authenticated, so the account is the accurate identity, and an IP key would
 * lump everyone behind one household NAT together. The ceiling is set for a
 * human scrolling fast through link-heavy scrollback — clients batch and dedupe
 * before asking, so hitting this means something is looping.
 */
const resolveThrottle = new RequestThrottle({
  windowMs: 60_000,
  maxRequests: 120,
});

/**
 * Per-account cap on BYTE requests.
 *
 * ⚠ The byte endpoint needs its own. Only `/resolve` was throttled, so any authenticated session
 * could loop `GET /media/:token` for a token it already held: keep-alive is off by design, so
 * each request opens a fresh upstream socket and pulls up to the cap — a few hundred in flight
 * saturate the cell's egress and file descriptors and hammer the origin from the operator's IP,
 * which is the exact resource the resolve throttle exists to protect.
 *
 * Set well above what a person browsing generates (the browser and iOS URLCache hold these for a
 * day, so a re-scroll costs nothing) and far below what a loop does.
 */
const mediaThrottle = new RequestThrottle({ windowMs: 60_000, maxRequests: 300 });

/**
 * Byte fetches in flight across the whole instance.
 *
 * ⚠ Its OWN pool, and not optional. The resolver's pool documents itself as the bound on the
 * feature's outstanding DNS lookups — `getaddrinfo` runs on libuv's thread pool and cannot be
 * cancelled, so a destroyed request keeps its slot for the full OS timeout, and the other DNS
 * consumer on this server is IRC connection setup. This route never went through that pool, and
 * it is the HIGHER-volume half: one resolve per link, but one byte request per image on screen.
 * `mediaThrottle` bounds the rate and not the concurrency, and the agents are deliberately
 * `keepAlive: false, maxSockets: Infinity`, so a session replaying tokens it already holds could
 * open sockets and uncancellable lookups without limit.
 *
 * Separate from the resolver's rather than shared with it because the two have opposite
 * profiles: a metadata fetch is a sub-second burst, a byte fetch can hold its slot for the
 * length of a video. Sharing would let one video stall every preview on the instance.
 */
const mediaPool = new SlotPool({ size: 24, maxQueued: 200, waitMs: 10_000 });

/** Total size of the resource a `Content-Range` describes, or null if it doesn't say. */
function contentRangeTotal(header: string | undefined): number | null {
  const total = /\/\s*(\d+)\s*$/.exec(header || '')?.[1];
  if (total === undefined) return null;
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

router.post(
  '/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    // Same inner gate as the byte route. The router isn't mounted when the feature is off, so
    // this is unreachable in a running server — but both endpoints answering the flag the same
    // way is what keeps that true if the mounting ever moves.
    if (!previewsEnabled()) {
      res.status(404).end();
      return;
    }

    // ⚠ `?? {}`, because Express 5's body-parser leaves `req.body` UNDEFINED rather than empty
    // for any request that isn't JSON — no Content-Type, `text/plain`, a form post. Reading
    // through it threw a TypeError into the error middleware, so the 400 two lines down was
    // dead code for precisely the malformed requests it exists to answer, and a client sending
    // the wrong content type got a 500 and a logged stack instead of being told what was wrong.
    const body = (req.body ?? {}) as { urls?: unknown };
    if (!Array.isArray(body.urls)) {
      res.status(400).json({ error: 'urls must be an array' });
      return;
    }

    const urls = body.urls
      .filter((u): u is string => typeof u === 'string')
      .slice(0, MAX_URLS_PER_REQUEST);

    const verdict = resolveThrottle.allow(String(req.user!.id));
    if (!verdict.ok) {
      res.set('Retry-After', String(verdict.retryAfter));
      res.status(429).json({ error: 'too many preview requests — slow down' });
      return;
    }

    // Resolved in parallel, but `resolvePreview` never rejects and coalesces
    // duplicates internally, so this can't turn into an unbounded fan-out or an
    // unhandled rejection.
    const previews = await Promise.all(
      urls.map(async (u) => toDescriptor(await resolvePreview(u))),
    );
    res.json({ previews });
  }),
);

router.get(
  '/media/:token',
  asyncHandler(async (req: Request, res: Response) => {
    if (!previewsEnabled()) {
      res.status(404).end();
      return;
    }

    const verdict = mediaThrottle.allow(String(req.user!.id));
    if (!verdict.ok) {
      res.set('Retry-After', String(verdict.retryAfter));
      res.status(429).json({ error: 'too many media requests — slow down' });
      return;
    }

    // The token is the capability: the server minted it during resolve, after the
    // URL had already passed the guard, so a client can only replay a decision we
    // made. It cannot author one.
    const raw = verifyProxyToken(String(req.params.token));
    if (!raw) {
      res.status(403).end();
      return;
    }

    // Re-vetted from scratch anyway. The token proves we approved this URL at some
    // point; it says nothing about where the name points NOW, and a DNS record
    // that was public an hour ago can be 10.0.0.5 today. safeRequest re-runs the
    // pinned lookup on every hop.
    const url = normalizeUrl(raw);
    if (!url) {
      res.status(403).end();
      return;
    }

    if (!(await mediaPool.acquire())) {
      // Saturated, not broken. 503 + Retry-After so a media element backs off and retries,
      // rather than 404, which an <img> treats as a permanent verdict and never re-asks.
      res.set('Retry-After', '5');
      res.status(503).end();
      return;
    }

    // ⚠ Registered BEFORE the fetch is awaited, and it owns the slot release.
    //
    // Attaching this after `await safeRequest(...)` — which can take the full hop deadline —
    // meant a client that aborted during the fetch had already fired `close`, so the listener
    // written to stop us "holding a socket to the origin" was attached to an event that would
    // never fire again. Writes then fail silently while the byte counter below keeps the
    // upstream in flowing mode, so the whole body drains to the origin's end with nobody to
    // send it to: connect-then-abort as a cheap amplifier.
    //
    // `close` on a response fires whether it finished or aborted, which makes it the one place
    // that always runs — so it is also where the pool slot goes back.
    let upstream: Awaited<ReturnType<typeof safeRequest>> | null = null;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      upstream?.stream.destroy();
      mediaPool.release();
    };
    res.on('close', finish);
    // A response already gone by the time we got a slot never emits `close` again.
    if (res.destroyed) {
      finish();
      return;
    }

    try {
      upstream = await safeRequest(url, {
        accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.5',
        // Forwarded so inline video works at all. Safari (iOS and macOS) refuses to play a
        // <video> whose source doesn't honour byte ranges, and seeking is broken everywhere
        // without it — and this route is what serves `kind === 'video'`.
        range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
        // Piped, not buffered: the scrape-tuned deadlines cut a healthy media transfer at 20 s
        // and read a backpressured <video> as a dead origin. See FetchOptions.streaming.
        streaming: true,
      });
      // The client left, or the stream died, while we were awaiting. Without this the response
      // never gets its `end()` — and `Content-Length` may already have gone out — so the
      // browser hangs on a half-open response with no error to show.
      if (done || res.destroyed || upstream.stream.destroyed) {
        finish();
        return;
      }

      // 206 is a success here: it's what a range request is asking for. 416 is the origin
      // telling the client its range is unsatisfiable, which is an answer the media element
      // knows how to act on — passing it through as 404 makes an unsatisfiable seek look like
      // a missing file.
      if (upstream.status === 416) {
        upstream.stream.destroy();
        if (upstream.headers['content-range']) {
          res.setHeader('Content-Range', String(upstream.headers['content-range']));
        }
        res.status(416).end();
        return;
      }
      const ok = upstream.status === 200 || upstream.status === 206;
      if (!ok || !proxyableContentType(upstream.contentType)) {
        upstream.stream.destroy();
        res.status(404).end();
        return;
      }
      // ⚠ Per-KIND cap. The single 8 MB ceiling was named for images and silently applied to
      // everything, so a 30 MB mp4 rendered inline was streamed to 8 MB and then had both ends
      // destroyed — the <video> died with a network error partway through, and since the
      // `immutable` Cache-Control had already gone out the browser could cache the truncated
      // body. Video and audio are streamed to a media element and are legitimately larger.
      const cap = upstream.contentType.startsWith('image/')
        ? MAX_IMAGE_PROXY_BYTES
        : MAX_MEDIA_PROXY_BYTES;
      const declared = Number(upstream.headers['content-length']);
      // ⚠ On a 206 the declared length is the length of the PART, so checking it alone let the
      // cap be walked straight past: a client asking for a gigabyte 1 MB at a time satisfies
      // `declared <= cap` every single time. The resource's real size is the figure after the
      // slash in Content-Range, and that is what the cap is about.
      const total = contentRangeTotal(upstream.headers['content-range'] as string | undefined);
      const oversize =
        (Number.isFinite(declared) && declared > cap) || (total !== null && total > cap);
      if (oversize) {
        upstream.stream.destroy();
        res.status(413).end();
        return;
      }

      res.setHeader('Content-Type', upstream.contentType);
      // Belt and braces against the response being interpreted as anything other
      // than the media type we just allowlisted.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      // No filename: it would come from a URL someone else controls.
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      // The token is a pure function of the URL, so a given token always denotes
      // the same bytes — safe to cache hard, and it's what keeps a scroll through
      // an image-heavy channel from re-proxying on every pass. `private` because
      // the response travels over an authenticated session.
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');

      // Range plumbing, so a media element can seek. ⚠ Only claimed when the origin actually
      // demonstrated it: advertising `Accept-Ranges: bytes` for a source that ignores Range
      // makes a media element seek by requesting a range and then silently receive the whole
      // file from byte zero, which reads as a seek that jumps back to the start.
      const upstreamRanges =
        upstream.status === 206 ||
        String(upstream.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
      if (upstreamRanges) res.setHeader('Accept-Ranges', 'bytes');
      if (upstream.headers['content-range']) {
        res.setHeader('Content-Range', String(upstream.headers['content-range']));
      }

      // ⚠ Content-Length is only forwarded when we KNOW we'll send exactly that many bytes.
      // Echoing it verbatim while the body was truncated at the cap produced a length/body
      // mismatch — the client saw ERR_HTTP_CONTENT_LENGTH_MISMATCH (a broken transfer) rather
      // than a clean, cacheable failure.
      if (Number.isFinite(declared) && declared <= cap) {
        res.setHeader('Content-Length', String(declared));
      }
      res.status(upstream.status === 206 ? 206 : 200);

      // Enforce the cap on bytes actually seen, not on the declared length — an
      // origin can omit Content-Length or lie about it.
      let sent = 0;
      const stream = upstream.stream;
      stream.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        if (sent > cap) {
          stream.destroy();
          res.destroy();
        }
      });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      // Blocked address, timeout, reset — all the same to a caller waiting on an
      // image, and none of them worth distinguishing in a status code.
      finish();
      if (!res.headersSent) res.status(404).end();
    }
  }),
);

export default router;
