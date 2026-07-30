// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The resolver: URL in, preview descriptor out, cached in between.
//
// Lazily driven. Nothing here runs on message arrival — a client asks for a URL
// when it's about to render one and the user has a setting on, which is what
// makes both features genuinely free when they're off. It also means scrollback
// and live messages take the identical path, so there is no backfill story and
// no "preview arrives after the message" race to design around.
//
// The Lounge does the opposite (fetch eagerly in the PRIVMSG handler, decorate
// the stored message), which is right for a server-global config knob and wrong
// for a per-user, default-off setting.

import sharp from 'sharp';
import {
  bufferStream,
  fetchBuffered,
  normalizeUrl,
  safeRequest,
  MAX_SCRAPE_BYTES,
  UnsafeUrlError,
  type RawResponse,
} from './linkFetch.js';
import { scrapeMeta, readOEmbed, decodeBody, type OEmbedMeta } from './linkMeta.js';
import { videoEmbedFor, oembedEndpointFor, isEmbeddableOrigin } from './linkEmbed.js';
import { previewsEnabled } from '../utils/previews.js';
import { SlotPool } from '../utils/slotPool.js';
import {
  getCachedPreview,
  putPreview,
  urlHash,
  OK_TTL_MS,
  FAIL_TTL_MS,
  type PreviewRecord,
  type PreviewKind,
} from '../db/linkPreviews.js';
import { mintProxyToken } from './mediaProxyToken.js';

/** Clamps, applied server-side so no client has to think about them and no
 *  client can be surprised by a 40 KB og:description. */
const MAX_TITLE = 140;
const MAX_DESCRIPTION = 300;
/** Cap on a preview image we're willing to pull down and proxy. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * Longest URL we'll carry.
 *
 * Applies to the URL asked about AND to any og:image / oEmbed thumbnail found on the page,
 * because both end up in a row, in a response, and — for the image — inside a minted proxy
 * token, which is base64 of the URL and therefore a third longer again. Nothing upstream caps
 * these: `normalizeUrl` is happy with a megabyte of query string, and `readOEmbed` reads a
 * `thumbnail_url` of any length straight out of a stranger's JSON. 2 KB is the de-facto ceiling
 * every browser and CDN already enforces, so anything past it wasn't going to load anyway.
 */
const MAX_URL_LENGTH = 2048;

/** Cap on URLs one resolve request may carry. Lives here rather than in the route so it can
 *  be tied to the concurrency limit below, which has to be at least this big. */
export const MAX_URLS_PER_REQUEST = 20;

/**
 * Outbound fetches in flight across the whole instance.
 *
 * A cap rather than a queue-per-user: the resource being protected is the instance's egress and
 * its standing with the hosts it talks to, and neither cares which account caused the traffic.
 *
 * ⚠ Must be >= MAX_URLS_PER_REQUEST, and overflow must QUEUE rather than fail. An earlier
 * version had a cap of 6 and answered overflow with `unavailable` immediately, which quietly
 * broke the common case rather than a rare one: `resolvePreview` runs synchronously up to its
 * first await, so `Promise.all` over a 20-URL batch started all 20 before any finished — calls
 * 7 through 20 saw a full pool and were refused without ever dialling. On a link-heavy history
 * page 6 previews rendered and 14 links stayed bare, and because the client stores whatever
 * verdict it's given, they stayed bare for the rest of the session.
 *
 * ⚠ This is also the only bound on how many DNS lookups the feature has outstanding, and that
 * matters more than it reads. `getaddrinfo` runs on libuv's thread pool, which caps it at
 * `(nthreads + 1) / 2` slots, and it CANNOT be cancelled — `req.destroy()` returns at once
 * while the lookup keeps its slot for the full OS timeout. Measured while building this: eight
 * concurrent blackholed lookups delayed an unrelated `dns.lookup` by ~20 s, and on this server
 * the other DNS consumer is IRC connection setup.
 *
 * The honest limits of the bound, since a comment claiming a guarantee is a claim to test:
 * it bounds fetches in flight, not lookups outstanding. A hop that gives up at
 * HOP_DEADLINE_MS frees its slot to a new fetch while its own lookup is still pending, so a
 * sustained stream of unresolvable hostnames can leave more than MAX_CONCURRENT lookups queued.
 * Fixing that needs a cancellable resolver (`dns.Resolver` over UDP rather than getaddrinfo),
 * which is a change to the fetcher, not to its caller. Bounding it here is what's available,
 * and it is strictly better than not bounding it.
 *
 * ⚠ Do NOT try to bound this with `maxSockets` on linkFetch's agents instead. node marks a
 * request `shouldKeepAlive = false` only when `!agent.keepAlive && !isFinite(agent.maxSockets)`,
 * and the agent hands a released socket to a queued same-host request before it ever consults
 * `keepAlive` — so capping the agents silently restores socket reuse, and a reused socket skips
 * DNS, which skips the pinned lookup that is the SSRF guard.
 */
const MAX_CONCURRENT = MAX_URLS_PER_REQUEST;
/**
 * Callers parked waiting for a slot, bounded so a flood can't grow this without limit.
 * Cross-request contention is what queues here; a single batch never has to.
 */
const MAX_QUEUED = 200;
/** How long a caller will wait for a slot before giving up, so an HTTP request can't hang on
 *  a backlog of slow origins. Recoverable: an `unavailable` from here is NOT written to the
 *  cache, and the client re-asks on the next priming pass. */
const MAX_QUEUE_WAIT_MS = 10_000;

const pool = new SlotPool({
  size: MAX_CONCURRENT,
  maxQueued: MAX_QUEUED,
  waitMs: MAX_QUEUE_WAIT_MS,
});

/**
 * Coalesce concurrent resolutions of the same URL.
 *
 * Fifty people in a channel scrolling past the same link is fifty requests
 * arriving within a second of each other and one cache entry that doesn't exist
 * yet. Without this they'd be fifty sockets to the same host, which is both
 * wasteful and precisely the behaviour that gets an IP rate-limited. The Lounge
 * keeps the same structure for the same reason.
 */
const inFlight = new Map<string, Promise<PreviewRecord>>();

function unavailable(url: string): PreviewRecord {
  return {
    url,
    status: 'unavailable',
    kind: 'page',
    title: null,
    description: null,
    siteName: null,
    author: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    embedUrl: null,
    mime: null,
    expiresAt: new Date(Date.now() + FAIL_TTL_MS).toISOString(),
  };
}

function clamp(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * What a Content-Type means for rendering.
 *
 * SVG is deliberately absent from the image branch. It is a document format that
 * executes script, not a picture — the uploader already refuses it (#553-era
 * media scrubbing), and letting one in here would reintroduce the same hole
 * through a different door.
 */
function kindForContentType(contentType: string): PreviewKind | null {
  if (contentType === 'image/svg+xml') return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'page';
  return null;
}

/** Fetch a discovered oEmbed endpoint. Best-effort: a failure just means we fall
 *  back to whatever the Open Graph tags gave us. */
async function fetchOEmbed(raw: string, base: URL): Promise<ReturnType<typeof readOEmbed>> {
  // ⚠ The RESOLVE is inside the try, not just the normalize — the same shape `safeRequest`
  // needed for a redirect `Location`. `raw` is an href scraped out of a stranger's markup, and
  // `new URL('http://[', base)` throws ERR_INVALID_URL while BUILDING normalizeUrl's argument,
  // so normalizeUrl's own guard never sees it. Escaping as a raw TypeError doesn't get past
  // `resolvePreview`'s catch, but it does abandon the whole page — a broken oEmbed href would
  // cost a site its preview entirely, when oEmbed is the fallback path and skipping it should
  // leave the Open Graph tags we already have.
  let url: URL | null = null;
  try {
    url = normalizeUrl(new URL(raw, base).toString());
  } catch {
    return null;
  }
  if (!url) return null;
  try {
    const res = await fetchBuffered(url, { accept: 'application/json', maxBytes: 64 * 1024 });
    if (res.status !== 200) return null;
    return readOEmbed(JSON.parse(res.body.toString('utf8')));
  } catch {
    return null;
  }
}

/** Assemble a page record from whatever combination of oEmbed and scraped tags we got. */
function pageRecord(
  url: URL,
  oembed: OEmbedMeta | null,
  meta: ReturnType<typeof scrapeMeta>,
): PreviewRecord {
  const embed = videoEmbedFor(url);
  const kind: PreviewKind = embed ? 'video-embed' : 'page';

  let imageUrl = oembed?.thumbnailUrl || meta.imageUrl;
  if (imageUrl) {
    // og:image is routinely relative, and a relative URL resolves against the
    // page we ACTUALLY landed on, not the one we asked for — redirects move the
    // base.
    //
    // ⚠ NOT decoded here. `scrapeMeta` and `readOEmbed` each decode entities at their own
    // boundary now, and decoding is deliberately once-only — a second pass turns a literal
    // `&amp;lt;` in a filename back into `<`, and `linkMeta.test.ts` asserts the single pass.
    let abs: URL | null = null;
    try {
      abs = normalizeUrl(new URL(imageUrl, url).toString());
    } catch {
      // `new URL` throws on input `normalizeUrl` would merely refuse — and this input came
      // from a stranger's markup, so it reaches us as anything at all.
      abs = null;
    }
    imageUrl = abs && abs.toString().length <= MAX_URL_LENGTH ? abs.toString() : undefined;
  }

  const title = clamp(oembed?.title || meta.title, MAX_TITLE);
  const description = clamp(meta.description, MAX_DESCRIPTION);

  // A card with no title and no image is a grey rectangle that says nothing.
  // Better to render the plain link the user typed.
  if (!title && !imageUrl) return unavailable(url.toString());

  return {
    url: url.toString(),
    status: 'ok',
    kind,
    title,
    description,
    siteName: clamp(oembed?.providerName || meta.siteName || url.hostname, MAX_TITLE),
    author: clamp(oembed?.authorName, MAX_TITLE),
    imageUrl: imageUrl ?? null,
    imageWidth: oembed?.thumbnailWidth ?? null,
    imageHeight: oembed?.thumbnailHeight ?? null,
    embedUrl: embed?.embedUrl ?? null,
    mime: null,
    expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
  };
}

/** Resolve an HTML page into a card by scraping it. */
async function resolveScrapedPage(
  url: URL,
  body: Buffer,
  charset: string | null,
): Promise<PreviewRecord> {
  // ⚠ The declared CHARSET, not the Content-Type header. `decodeBody` used to re-parse
  // `charset=…` out of what it was handed, but what reached it was `RawResponse.contentType`,
  // already stripped to a bare `text/html` — a branch that could never match, so
  // `charset=windows-1251` with no in-document `<meta charset>` fell through to UTF-8 and
  // rendered as replacement characters. `BufferedResponse` carries the parsed charset as its
  // own field for exactly this call.
  const html = decodeBody(body, charset);
  const meta = scrapeMeta(html);

  // Discovered oEmbed still wins over the scraped tags where a page advertises one, matching
  // Slack: it's a structured, versioned answer from the site itself rather than a bag of
  // strings. This is the discovery path, for sites not in the provider table.
  const oembed = meta.oembedUrl ? await fetchOEmbed(meta.oembedUrl, url) : null;
  return pageRecord(url, oembed, meta);
}

/**
 * Pixel dimensions of an image, from as few bytes as we can get away with.
 *
 * Purely so clients can reserve the right amount of space *before* the bytes arrive. Without
 * it a message list grows twice — once when the metadata lands and again when the image
 * decodes — and in a bottom-anchored chat log the second one yanks the reader off the live
 * tail. With an aspect ratio in hand the box is allocated at metadata time and the image
 * simply appears inside it.
 *
 * A header-sized read is enough for every format that matters: the dimensions live in the
 * first few hundred bytes of a JPEG/PNG/GIF/WebP. Failure is fine and common (a truncated
 * buffer sharp can't parse, an exotic format) — the clients fall back to a fixed max height,
 * which is merely the old behaviour.
 */
async function imageDimensions(
  res: RawResponse,
): Promise<{ width: number; height: number } | null> {
  try {
    const head = await bufferStream(res, { maxBytes: 64 * 1024 });
    const meta = await sharp(head.body).metadata();
    if (meta.width && meta.height) return { width: meta.width, height: meta.height };
  } catch {
    // Not worth distinguishing: no dimensions means no reservation, not no preview.
  }
  return null;
}

async function doResolve(raw: string): Promise<PreviewRecord> {
  const url = normalizeUrl(raw);
  if (!url) return unavailable(raw);

  // Known providers are asked directly, BEFORE anything is fetched from the page itself.
  // For YouTube this is the difference between working and not: its og: tags sit past
  // half a megabyte of inline script, while its oEmbed endpoint answers in under a
  // kilobyte. See `oembedEndpointFor`.
  const endpoint = oembedEndpointFor(url);
  if (endpoint) {
    const oembed = await fetchOEmbed(endpoint, url);
    if (oembed?.title) return pageRecord(url, oembed, {});
    // Fall through and scrape. A provider can be down, or rate-limiting us, or have
    // retired an endpoint — none of which should mean no preview at all.
  }

  const res = await safeRequest(url, {});
  if (res.status !== 200) {
    res.stream.destroy();
    return unavailable(raw);
  }

  const kind = kindForContentType(res.contentType);
  if (kind === null) {
    res.stream.destroy();
    return unavailable(raw);
  }

  // Direct media: the URL IS the content, so there's nothing to scrape. For an image we
  // read a header's worth to learn its dimensions — see `imageDimensions` for why that
  // matters more than it looks — and for video/audio we stop at the headers, since the
  // client asks the proxy for the bytes and only if it actually renders it.
  if (kind !== 'page') {
    const size = kind === 'image' ? await imageDimensions(res) : null;
    res.stream.destroy();
    return {
      url: url.toString(),
      status: 'ok',
      kind,
      title: null,
      description: null,
      siteName: null,
      author: null,
      imageUrl: url.toString(),
      imageWidth: size?.width ?? null,
      imageHeight: size?.height ?? null,
      embedUrl: null,
      mime: res.contentType,
      expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
    };
  }

  // Buffered off the response we already have, rather than re-requesting: a second GET for
  // the body doubled every page fetch, and doubled the chance of a rate limit on a host we
  // want to stay welcome at. `stopAtHeadEnd` means a well-formed page costs its head only.
  const buffered = await bufferStream(res, {
    maxBytes: MAX_SCRAPE_BYTES,
    stopAtHeadEnd: true,
  });
  return await resolveScrapedPage(buffered.finalUrl, buffered.body, buffered.charset);
}

/**
 * Resolve one URL to a cached-or-fresh preview record.
 *
 * Never throws. Every failure path — malformed URL, blocked address, timeout,
 * 403, unusable content type — becomes an `unavailable` record, which is a real
 * cacheable answer rather than an error to handle. That's what keeps a dead link
 * in old scrollback from reopening a socket every time someone scrolls past it.
 */
export async function resolvePreview(raw: string): Promise<PreviewRecord> {
  // The flag first, before even a cache read: "off" means the feature isn't participating, not
  // that it serves stale answers it happens to still have. The routes aren't mounted either —
  // this is the inner half of the same decision.
  if (!previewsEnabled()) return unavailable(raw);
  // Refused before it can be hashed, stored, or echoed. Nothing downstream caps a URL's
  // length, and this one arrived in a request body.
  if (raw.length > MAX_URL_LENGTH) return unavailable(raw);

  const cached = getCachedPreview(raw);
  // ⚠ Re-stamped with the URL as ASKED, not as stored. The row is keyed with the fragment
  // stripped so `#intro` and `#appendix` of one document share a fetch — which means the `url`
  // column holds whichever of them arrived first. Returning that verbatim is the same
  // client-side miss that echoing a post-redirect URL caused (the client looks a preview up by
  // the string it sent), except reached through the cache rather than through a redirect, and
  // only for the second reader onward — so it renders correctly for whoever resolved it and
  // silently for nobody else.
  if (cached) return { ...cached, url: raw };

  // ⚠ Keyed by the STORAGE identity, not by the request string, and re-stamped on the way out
  // for the same reason the cache read above is. Keyed by `raw`, two anchors of one document
  // arriving in the same batch — which is exactly how anchors arrive — coalesced with nothing
  // and cost two fetches of the same page, quietly undoing the fragment collapse the cache key
  // exists to provide.
  const key = urlHash(raw);
  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), url: raw };

  const task = (async (): Promise<PreviewRecord> => {
    // ⚠ `acquired` and the try must wrap EVERYTHING, including the give-up path. An earlier
    // version returned before entering the try, so `finally` never ran and the resolved
    // `unavailable` promise stayed pinned in `inFlight` for the life of the process — every
    // later request for that URL replayed it via the `if (pending)` short-circuit above, never
    // consulting the DB cache again. That's permanent blankness, which is precisely what the
    // "deliberately not cached" note below was trying to avoid.
    let acquired = false;
    try {
      acquired = await pool.acquire();
      if (!acquired) {
        // Deliberately NOT cached: this says nothing about the URL, only that the instance was
        // saturated when we asked. Caching it would turn a momentary spike into a permanently
        // blank preview.
        return unavailable(raw);
      }
      const resolved = await doResolve(raw);
      // ⚠ Always echo the URL we were ASKED about, whatever the fetch ended up at.
      //
      // The endpoint's contract is one descriptor per input, in order, and callers look each
      // one up by the string they sent. Returning a post-redirect URL broke that silently in
      // both directions: the client's `cache.get(preview.url)` missed, so nothing ever
      // rendered, and `putPreview` wrote a row keyed by something no lookup would ever ask
      // for, so every resolve re-hit the origin. The canonical URL is still used internally
      // where it matters — resolving a relative og:image against the page we actually landed
      // on — it just isn't the identity.
      const record = { ...resolved, url: raw };
      putPreview(record);
      return record;
    } catch (err) {
      // An SSRF refusal is worth a line — it's either a misconfigured link or
      // somebody probing. Everything else (timeouts, resets, 403s) is ordinary
      // internet weather and would only be log noise.
      if (err instanceof UnsafeUrlError) {
        console.warn(`[lurker] link preview refused: ${err.message}`);
      }
      const record = unavailable(raw);
      putPreview(record);
      return record;
    } finally {
      // Only release what we actually took; always clear the in-flight entry.
      if (acquired) pool.release();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return await task;
}

/** The wire shape handed to clients. Byte URLs are minted here, so a client
 *  never learns to construct one — see mediaProxyToken. */
export interface PreviewDescriptor {
  url: string;
  status: 'ok' | 'unavailable';
  kind: PreviewKind;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  src?: string;
  thumb?: string;
  thumbWidth?: number;
  thumbHeight?: number;
  embedUrl?: string;
  mime?: string;
  expiresAt: string;
}

export function toDescriptor(record: PreviewRecord): PreviewDescriptor {
  const d: PreviewDescriptor = {
    url: record.url,
    status: record.status,
    kind: record.kind,
    expiresAt: record.expiresAt,
  };
  if (record.status !== 'ok') return d;

  if (record.title) d.title = record.title;
  if (record.description) d.description = record.description;
  if (record.siteName) d.siteName = record.siteName;
  if (record.author) d.author = record.author;
  if (record.mime) d.mime = record.mime;
  // ⚠ Re-checked on the way out, against the shared allowlist rather than a `startsWith`.
  // `embedUrl` is the one field a client puts in an <iframe>, and this value came back out of
  // a cache row — so what's asserted here isn't "did videoEmbedFor behave", it's "whatever is
  // in the row, we only ever hand clients an origin we're willing to frame". There is still no
  // CSP anywhere in this repo, so this check is the frame-src.
  if (record.embedUrl && isEmbeddableOrigin(record.embedUrl)) d.embedUrl = record.embedUrl;
  if (record.imageWidth) d.thumbWidth = record.imageWidth;
  if (record.imageHeight) d.thumbHeight = record.imageHeight;

  if (record.imageUrl) {
    const proxied = `/api/link-preview/media/${mintProxyToken(record.imageUrl)}`;
    // For direct media the bytes ARE the content (`src`); for a page they're
    // decoration on a card (`thumb`). Same proxy, different slot, so a client
    // never has to re-derive which one it's looking at from `kind`.
    if (record.kind === 'image' || record.kind === 'video' || record.kind === 'audio') {
      d.src = proxied;
    } else {
      d.thumb = proxied;
    }
  }
  return d;
}

/** Ceiling on preview IMAGE bytes the proxy will serve. */
export const MAX_IMAGE_PROXY_BYTES = MAX_IMAGE_BYTES;
/** Ceiling on VIDEO/AUDIO bytes. Larger because these stream to a media element rather than
 *  being decoded whole — an 8 MB cut-off truncated ordinary clips mid-playback. */
export const MAX_MEDIA_PROXY_BYTES = 64 * 1024 * 1024;
