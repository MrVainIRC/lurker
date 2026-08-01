// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The preview byte cache, as the route sees it: `lookup` before fetching, `store`
// after. Everything below this line is a backend detail.
//
// ⚠⚠ THE CACHE IS NEVER A FAILURE PATH. Every function here answers "miss" rather
// than throwing, for every cause — misconfiguration, a wiped directory, a locked
// database, a race with eviction. The uncached path is a complete, working feature
// (it is what shipped, and what runs with the cache off), so any doubt resolves to
// using it. A cache that can break the thing it accelerates is worse than no cache.
// ⚠ That was a CLAIM before it was true: `lookup` threw a SQLITE_BUSY straight out
// of the route, past a `try` that did not open for another seventy lines, and 500'd
// an image request that would have succeeded with caching switched off. The guard
// now lives in this module, where the promise is made.
//
// ⚠ IMAGES ONLY, deliberately. Video and audio are capped at MAX_MEDIA_PROXY_BYTES
// (64 MB) against images' 8 MB, they are served with RANGE requests so a cached
// copy would have to answer partial reads, and one seek in a video is many
// requests for one object. Buffering 64 MB per miss would trade the bandwidth this
// feature saves for memory it cannot bound.

import crypto from 'crypto';
import { lookupCached, recordCached, forget } from '../../db/previewCache.js';
import { kindForContentType } from '../linkPreview.js';
import { resolveCacheConfig, type CacheConfig } from './config.js';
import { evictLocal, objectPath, readLocal, removeLocal, writeLocal } from './local.js';

export type { CacheConfig, CacheMode } from './config.js';
export { objectPath };

/** Served from bytes we hold. The only hit shape `local` can produce. */
export interface BufferHit {
  kind: 'buffer';
  body: Buffer;
  contentType: string;
}
export type CacheHit = BufferHit;

/**
 * The cache key for one URL's BYTES.
 *
 * ⚠⚠ Its own digest, deliberately NOT `db/linkPreviews.ts`'s `urlHash`. That one
 * folds in `RESOLVER_VERSION`, a counter whose entire job is to invalidate
 * METADATA when the resolver would produce a different record — it has already
 * been bumped for a WebP/GIF *dimension* change, and its docblock actively invites
 * more. Sharing it would mean a routine metadata bump silently discards every
 * cached byte on the instance and re-fetches every image at once, from a diff that
 * never mentions this module and a reviewer who has no reason to look here. The
 * identity of a cached picture is its URL, and nothing else.
 *
 * ⚠ Canonicalised the way `urlHash` does — fragment stripped — so `#a` and `#b` of
 * one image share an object rather than being fetched and stored twice.
 */
export function byteCacheKey(url: string): string {
  let key: string;
  try {
    const canonical = new URL(url);
    canonical.hash = '';
    key = canonical.toString();
  } catch {
    key = url.replace(/#[\s\S]*$/, '');
  }
  return crypto.createHash('sha256').update(`bytes-v1|${key}`).digest('hex');
}

/**
 * ⚠ Resolved ONCE per process, not per request.
 *
 * The config comes from the environment, which cannot change under a running
 * process, and re-reading it per byte request would re-run the validation — and
 * re-log its warnings — on the hottest path this feature has.
 */
let cached: CacheConfig | null = null;

export function cacheConfig(): CacheConfig {
  cached ??= resolveCacheConfig();
  return cached;
}

/** Test seam: drop the memoised config so the next call re-reads the environment. */
export function resetCacheConfigForTests(): void {
  cached = null;
}

export function cacheEnabled(): boolean {
  return cacheConfig().mode !== 'off';
}

/**
 * Is this worth caching at all?
 *
 * Exported because the route makes the same judgement twice — once to decide
 * whether to look, once to decide whether to store — and two copies of a predicate
 * is how they drift.
 *
 * ⚠⚠ Asks `kindForContentType`, never `startsWith('image/')`. That allowlist is the
 * one place `image/svg+xml` is refused — "a scripting format wearing a picture's
 * clothes", in the resolver's own words — and a second copy of that rule is
 * precisely how it nearly got served under our origin once before. A `startsWith`
 * test here accepted SVG, and was safe only because `proxyableContentType` happens
 * to run thirty-five lines earlier in the one caller. That is an ordering, not a
 * guarantee.
 */
export function cacheable(contentType: string | undefined, isRangeRequest: boolean): boolean {
  if (!cacheEnabled()) return false;
  // ⚠ A range request is passed straight through, never served from cache and never
  // stored. Answering one correctly means honouring an arbitrary byte window, and
  // the only content that asks for ranges is the media this cache excludes anyway.
  // Serving a whole object to a request for bytes 100-200 is a correctness bug.
  if (isRangeRequest) return false;
  return !!contentType && kindForContentType(contentType) === 'image';
}

/**
 * A cached copy, or null. Never throws.
 *
 * ⚠ Repairs the index rather than merely missing. A row whose file has vanished —
 * a wiped volume, a restored backup, a manual `rm` — would otherwise answer "hit"
 * forever, costing a failed read before the origin fetch that was going to happen
 * anyway, because nothing else ever revisits the row.
 *
 * ⚠⚠ The SIZE is checked, not just presence. `writeLocal` does not fsync before
 * renaming, so a power loss or a killed container can leave a short file under a
 * row (WAL-durable) claiming the full length. `readFile` then succeeds, nothing
 * throws, and the stump is served with `max-age=86400, immutable` — a permanently
 * broken image every viewer holds for a day. A zero-length Buffer is also truthy,
 * so a presence test does not catch that one either.
 */
export async function lookup(key: string): Promise<CacheHit | null> {
  try {
    const cfg = cacheConfig();
    if (cfg.mode !== 'local') return null;

    const entry = lookupCached(key);
    if (!entry) return null;
    // ⚠ A row from another backend is FORGOTTEN, not merely skipped. Left in place
    // after a mode change it is unreachable and uncounted at once, so its bytes sit
    // on the volume forever with nothing able to name them.
    if (entry.backend !== cfg.mode) {
      forget(key);
      return null;
    }

    const body = await readLocal(cfg, key);
    if (!body || body.length !== entry.size) {
      forget(key);
      if (body) await removeLocal(cfg, key);
      return null;
    }
    return { kind: 'buffer', body, contentType: entry.contentType };
  } catch {
    return null;
  }
}

/**
 * Outstanding cache DECISIONS — not outstanding writes.
 *
 * ⚠⚠ A test seam, and the distinction is the whole reason it exists. The route
 * deliberately does not await a store: the reader already has their bytes, and a
 * slow disk must not hold the response open. From outside, that makes "nothing was
 * cached" and "the decision has not been reached yet" indistinguishable — so a
 * suite asserting an ABSENCE (a truncated body must not be stored; a video must
 * not be) can pass for the wrong reason and never know.
 *
 * ⚠ An earlier version counted writes in flight and was worse than useless: it
 * resolved instantly whenever no store had *started*, which is precisely the state
 * an absence test is in, and reverting the truncation guard left the suite green.
 */
let pendingDecisions = 0;
let decisionWaiters: Array<() => void> = [];

/** Register a cache decision that has begun. Returns its one-shot settle. */
export function trackPendingStore(): () => void {
  pendingDecisions++;
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    pendingDecisions--;
    if (pendingDecisions > 0) return;
    const waiters = decisionWaiters;
    decisionWaiters = [];
    for (const w of waiters) w();
  };
}

/** Resolves once every begun decision has been reached. Test-only. */
export function whenStoresSettle(): Promise<void> {
  if (pendingDecisions === 0) return Promise.resolve();
  return new Promise((resolve) => decisionWaiters.push(resolve));
}

/**
 * Store bytes we just fetched. Returns whether anything was kept. Never throws.
 *
 * ⚠ The row is written only AFTER the bytes are, and rolled back if the index
 * write fails. An index entry for an object that does not exist is the state this
 * design cannot tolerate quietly.
 */
export async function store(key: string, body: Buffer, contentType: string): Promise<boolean> {
  try {
    const cfg = cacheConfig();
    if (cfg.mode !== 'local') return false;

    // ⚠ Room is made BEFORE the write, so the ceiling is never crossed and eviction
    // is not gated on the success of the very write it exists to enable — which is
    // what made it unreachable on a full volume, the one time it matters.
    await evictLocal(cfg, body.length);

    if (!(await writeLocal(cfg, key, body))) return false;
    try {
      recordCached({ key, backend: cfg.mode, contentType, size: body.length });
    } catch {
      // The bytes landed but the index did not, so nothing could ever find them.
      await removeLocal(cfg, key);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
