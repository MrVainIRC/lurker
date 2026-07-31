// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client half of link previews.
//
// ⚠⚠ Resolution is driven by message INGEST, never by rendering. `primePreviews` is called
// when messages enter the store — a backlog frame, a history page, a live message — and
// components only ever READ, through `useLinkPreview`.
//
// The first version had this backwards: a row asked for its preview *while rendering*, which
// kicked off a fetch, which mutated shared state, which grew the row, which forced the list to
// correct its own scroll position. Rendering had side effects, so every scroll into history
// triggered async growth and needed bespoke compensation. QA felt it exactly as described:
// "the chat loads in completely flat, then inline content loads in a burst, throwing off the
// scroll offset".
//
// Slack and Discord don't have this problem because an unfurl is part of the message record —
// it arrives WITH the message, so scrollback is laid out correctly on first paint and async
// growth only happens for a brand-new message at the bottom, where the list already follows.
// Priming at ingest is how we get that property without the server storing unfurls on every
// message (which would mean fetching for people who have the feature off).
//
// Two layers of coalescing, catching different things:
//
//   - `cache` dedupes across TIME. Scroll past a link and back, and the second pass is free.
//   - `queue` dedupes across a TICK. A history page arrives with fifty rows; they become one
//     POST rather than fifty.

import { ref, type Ref } from 'vue';
import { api } from '../api.js';
import { previewableUrls, type PreviewToggles } from '../utils/previewUrls.js';

export type PreviewKind = 'image' | 'video' | 'audio' | 'page' | 'video-embed';

export interface LinkPreview {
  url: string;
  status: 'ok' | 'unavailable';
  kind: PreviewKind;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  /** Proxied bytes for direct media. Server-minted — never built here. */
  src?: string;
  /** Proxied card thumbnail. Server-minted — never built here. */
  thumb?: string;
  thumbWidth?: number;
  thumbHeight?: number;
  embedUrl?: string;
  mime?: string;
  expiresAt: string;
}

// Module-level, not per-component: two message rows showing the same link must
// share one entry, and a row that unmounts on scroll must not throw away what
// it learned.
const cache = new Map<string, Ref<LinkPreview | null>>();

/**
 * URLs priming has already asked about.
 *
 * ⚠ Tracked SEPARATELY from `cache`, and that separation is load-bearing. `useLinkPreview`
 * creates an empty entry as a side effect of being read, so when the skip condition was
 * `cache.has(url)` a mere RENDER blocked that URL from ever being primed. The failure was
 * exactly the default path: with both settings off nothing primes, then the user switches one
 * on, every visible URL gets a null entry from the render pass, and no later history page or
 * live message could ever queue them because they "already existed". Previews stayed missing
 * until a full reload.
 */
const asked = new Set<string>();

/**
 * Bumped when a batch of previews lands and something changed.
 *
 * Only for the residual case: a reader scrolling fast enough to outrun the priming request,
 * so a row renders before its preview is known and grows when it arrives. With priming at
 * ingest this is the exception rather than — as it was — every single scroll into history.
 */
export const previewRevision = ref(0);

let queue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Server cap per request; batching past it just means a second POST. */
const MAX_BATCH = 20;
/**
 * One frame-ish. Long enough that everything mounting in the same tick lands in
 * one batch, short enough that a preview never feels like it's lagging behind
 * the scroll.
 */
const FLUSH_MS = 24;

async function flush(): Promise<void> {
  flushTimer = null;
  const urls = [...queue];
  queue = new Set();
  if (urls.length === 0) return;

  for (let i = 0; i < urls.length; i += MAX_BATCH) {
    const slice = urls.slice(i, i + MAX_BATCH);
    try {
      const res = await api<{ previews: LinkPreview[] }>('/api/link-preview/resolve', {
        method: 'POST',
        body: { urls: slice },
      });
      let changed = false;
      const answered = new Set<string>();
      for (const preview of res.previews ?? []) {
        const entry = cache.get(preview.url);
        // Only an `ok` preview renders anything, so only an `ok` preview can change a row's
        // height — bumping the revision for a batch of `unavailable` answers would make the
        // list re-pin for no reason.
        if (entry) {
          answered.add(preview.url);
          entry.value = preview;
          if (preview.status === 'ok') {
            changed = true;
            retry.delete(preview.url);
          } else {
            armReask(preview.url, Date.parse(preview.expiresAt ?? ''));
          }
        }
      }
      // ⚠⚠ Reconciled against what was SENT, not just iterated over what came back. A URL the
      // server omits — a truncated response, a batch cap drifting out of step with MAX_BATCH,
      // a 200 carrying an error body that `?? []` turns into zero previews — otherwise reached
      // a state no recovery path could see: `asked` still holds it so priming skips it, no
      // `retry` entry exists so nothing re-asks it, and `dropIfExpired` returns early because a
      // null value has no `expiresAt`. Permanently blank, from a response that looked fine.
      for (const url of slice) if (!answered.has(url)) forgetForRetry(url);
      if (changed) previewRevision.value++;
      scheduleReask();
    } catch {
      // A failed resolve leaves the ref null, which renders as "no preview" — the same as a
      // link the server couldn't unfurl. There is nothing useful to tell the user about a
      // decoration that didn't appear, and an error state in the message list would be worse
      // than the missing card. Every URL in the slice is put back in play; none of them got an
      // answer, so none of them has a verdict to remember.
      for (const url of slice) forgetForRetry(url);
      scheduleReask();
    }
  }
}

// ─── Re-asking an `unavailable` once its TTL lapses ───────────────────────────
//
// ⚠⚠ The server deliberately does NOT cache some failures — pool saturation, a resolve
// deadline — and stamps them with a ~15s `expiresAt` instead of the one-hour failure TTL,
// specifically so a client comes back. Nothing was coming back: `dropIfExpired` only runs
// inside `primePreviews`, which is driven by INGEST, and a message already in the store is
// never ingested again. So a transient failure was indistinguishable from a permanent verdict
// and the row stayed blank for the life of the tab — the exact outcome the server-side
// transient/verdict split was built to avoid.
//
// This is time-driven, not render-driven, so the "a read is a read" invariant at the top of
// this file still holds: rendering a row still cannot cause a fetch.

/**
 * When to ask again about a URL, and how many times we already have.
 *
 * `at: Infinity` means "asked, waiting for the answer" — see `runReask`.
 */
const retry = new Map<string, { at: number; tries: number }>();
let reaskTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Floor on the gap between re-asks, doubling per consecutive failure up to a ceiling.
 *
 * ⚠ A FLOOR, not the delay itself — the delay is whatever the server's own `expiresAt` asks
 * for, and this only raises it. That distinction is what keeps the steady state cheap without
 * needing an attempt cap: a genuinely dead URL is answered with the one-hour failure TTL, so
 * its next ask is an hour out and the floor never binds. The floor binds only on the 15s
 * transient answer, which means the instance is saturated — precisely when backing off is the
 * right thing to do rather than re-asking every 15 seconds for as long as the tab is open.
 */
const REASK_FLOOR_MS = 15_000;
const REASK_CEILING_MS = 5 * 60_000;

/**
 * The longest TTL that still means "come back" rather than "this is the answer".
 *
 * ⚠⚠ Without this test every dead link became a perpetual poller. The server answers a real
 * failure with a one-hour TTL and a transient refusal with ~15 seconds, and re-asking both
 * meant 300 dead links scrolled past turned into 300 outbound fetches an hour, per open tab,
 * forever. Worse, the client's hourly deadline and the server's row TTL start at the same
 * instant, so the re-ask landed just AFTER `expires_at` lapsed — a guaranteed cache miss and a
 * fresh fetch to a known-dead origin every single time. A verdict is re-asked only by a new
 * priming pass, which is what `dropIfExpired` is for.
 */
const VERDICT_TTL_MS = 60_000;

/** ±25%, matching the server's own jitter on the TTL it sends. */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function armReask(url: string, expiresAtMs: number): void {
  const untilExpiry = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : 0;
  if (untilExpiry > VERDICT_TTL_MS) {
    retry.delete(url);
    return;
  }
  const tries = (retry.get(url)?.tries ?? 0) + 1;
  const floor = Math.min(REASK_CEILING_MS, REASK_FLOOR_MS * 2 ** (tries - 1));
  // ⚠ Jittered, and this is not cosmetic. The server jitters its transient TTL specifically so
  // that "every loser of one saturation event doesn't come back as a single wave" — and taking
  // `max(untilExpiry, floor)` against a fixed floor threw that away, re-synchronising every
  // client onto the same millisecond. A thundering herd aimed at a server that has just said it
  // is overloaded.
  retry.set(url, { at: Date.now() + jitter(Math.max(untilExpiry, floor)), tries });
}

/**
 * Put a URL back in play after an answer that wasn't one.
 *
 * ⚠⚠ The ref is deliberately NOT deleted. `MessageAttachments` captures the Ref OBJECT in a
 * computed keyed on the message text, so a mounted row goes on watching whichever object it
 * first received. Deleting the cache entry and minting a fresh one on the next ask therefore
 * delivered the answer into an object nothing was watching: a fresh read showed `ok` while the
 * row on screen stayed blank forever. Resetting `asked` re-opens the URL to priming without
 * ever changing its identity.
 */
function forgetForRetry(url: string): void {
  if (!cache.has(url)) return;
  asked.delete(url);
  armReask(url, NaN);
}

/** One timer for the whole map, set to the earliest deadline — not a timer per URL. */
function scheduleReask(): void {
  if (reaskTimer !== null) {
    clearTimeout(reaskTimer);
    reaskTimer = null;
  }
  let earliest = Infinity;
  for (const { at } of retry.values()) earliest = Math.min(earliest, at);
  if (!Number.isFinite(earliest)) return;
  reaskTimer = setTimeout(() => runReask(), Math.max(0, earliest - Date.now()));
}

function runReask(): void {
  reaskTimer = null;
  const now = Date.now();
  let queued = false;
  for (const [url, state] of retry) {
    if (state.at > now) continue;
    // Evicted by the cache ceiling, or dropped by `dropIfExpired` on a priming pass — either
    // way nobody is holding a ref for it, so there is nothing to re-ask on behalf of.
    if (!cache.has(url)) {
      retry.delete(url);
      continue;
    }
    // Parked as in-flight rather than deleted, and the difference is the whole backoff: the
    // `tries` count lives in this entry, so deleting it meant the answer re-armed at tries=1
    // every time and the floor never doubled — a "backoff" that was a flat 15s poll.
    // Re-armed by whatever comes back (an answer, or the transport-failure branch in `flush`).
    // Queued directly rather than through the `asked` gate: this URL is deliberately being
    // asked about a second time.
    retry.set(url, { at: Infinity, tries: state.tries });
    queue.add(url);
    queued = true;
  }
  if (queued && flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  scheduleReask();
}

/**
 * Ceiling on remembered URLs.
 *
 * A long-lived tab would otherwise accumulate an entry per distinct URL for as long as it's
 * open. Evicts oldest-first: `Map` preserves insertion order, and the oldest entry is the one
 * least likely to still be on screen.
 */
const MAX_CACHE_ENTRIES = 2000;

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    asked.delete(oldest);
    retry.delete(oldest);
  }
}

/** Drop entries whose server-side TTL has lapsed, so they can be asked about again.
 *  `expiresAt` was being carried on the wire and never read. */
function dropIfExpired(url: string): void {
  const entry = cache.get(url);
  const expiresAt = entry?.value?.expiresAt;
  if (!expiresAt) return;
  if (Date.parse(expiresAt) > Date.now()) return;
  // ⚠ Neither the ref nor the backoff ladder is discarded. The ref because mounted rows hold it
  // (see `forgetForRetry`); the `retry` entry because `tries` is the only record of how many
  // times this URL has already failed — dropping it reset the ladder to zero, so a channel
  // where a bot reposts a failing link never accumulated any backoff at all. The stale value
  // keeps rendering meanwhile, which beats blanking a card that is merely due a refresh.
  asked.delete(url);
}

function entryFor(url: string): Ref<LinkPreview | null> {
  let entry = cache.get(url);
  if (!entry) {
    entry = ref<LinkPreview | null>(null);
    cache.set(url, entry);
  }
  return entry;
}

/**
 * Ask the server about every previewable URL in a batch of message bodies.
 *
 * Called at INGEST — from the socket layer, as messages enter the store — so that by the time
 * a row is rendered its preview is usually already known and the row is laid out correctly on
 * its first paint. Idempotent and cheap: a URL already known or already queued is skipped, so
 * calling this for an overlapping page costs a map lookup per URL.
 *
 * Returns immediately. Nothing awaits it: a history page must not wait on the internet before
 * it can be read.
 */
export function primePreviews(
  texts: readonly (string | null | undefined)[],
  toggles: PreviewToggles,
): void {
  if (!toggles.inlineMedia && !toggles.linkPreviews) return;
  let queued = false;
  for (const text of texts) {
    for (const url of previewableUrls(text, toggles)) {
      dropIfExpired(url);
      if (asked.has(url)) continue;
      asked.add(url);
      entryFor(url);
      queue.add(url);
      queued = true;
    }
  }
  if (queued && flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  evictIfNeeded();
}

/**
 * The preview for `url`, if one is known.
 *
 * READ-ONLY: this never triggers a fetch. A component asking about a URL nobody primed gets a
 * permanently-null ref and renders nothing — which is correct, and is the property that keeps
 * rendering free of side effects.
 */
export function useLinkPreview(url: string): Ref<LinkPreview | null> {
  return entryFor(url);
}

/** Test-only: drop everything so a suite starts from a known state. */
export function resetLinkPreviewCache(): void {
  previewRevision.value = 0;
  cache.clear();
  asked.clear();
  retry.clear();
  queue = new Set();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // The re-ask timer too. `retry.clear()` above already makes a leaked one a no-op — it would
  // wake to an empty map — so this is hygiene rather than a guard, and is deliberately not
  // asserted by a test that would pass with it removed. It's here because a pending timer still
  // holds the event loop open.
  if (reaskTimer !== null) {
    clearTimeout(reaskTimer);
    reaskTimer = null;
  }
}
