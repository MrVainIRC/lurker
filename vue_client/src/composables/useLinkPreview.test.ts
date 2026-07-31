// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  primePreviews,
  useLinkPreview,
  usePreviewsSettled,
  resetLinkPreviewCache,
} from './useLinkPreview.js';
import * as apiModule from '../api.js';
import { ref } from 'vue';

const BOTH = { inlineMedia: true, linkPreviews: true };

let posted: string[][];
/** What the fake server does with a batch. Swappable mid-test so a suite can make the
 *  instance fail and then recover, which is the whole shape of the re-ask cases below. */
let respond: (urls: string[]) => unknown;

const okFor = (urls: string[]) => ({
  previews: urls.map((url) => ({
    url,
    status: 'ok',
    kind: 'page',
    title: 'T',
    expiresAt: '2099-01-01T00:00:00Z',
  })),
});

/** What the server sends when it declined to even try — pool saturation, a resolve deadline.
 *  Deliberately NOT cached server-side, and stamped with a seconds-long TTL rather than the
 *  one-hour failure TTL, precisely so a client comes back. See TRANSIENT_TTL_MS. */
const transientFor = (urls: string[]) => ({
  previews: urls.map((url) => ({
    url,
    status: 'unavailable',
    kind: 'page',
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
  })),
});

beforeEach(() => {
  resetLinkPreviewCache();
  posted = [];
  respond = okFor;
  vi.spyOn(apiModule, 'api').mockImplementation(async (_url, opts) => {
    const urls = ((opts ?? {}).body as { urls: string[] }).urls;
    posted.push(urls);
    return respond(urls) as never;
  });
});

afterEach(() => vi.restoreAllMocks());

/** Let the coalescing timer fire and the request settle. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('rendering has no side effects', () => {
  it('reading a preview NEVER triggers a request', async () => {
    // ⚠⚠ The architectural invariant. The first version resolved as a side effect of
    // rendering, which meant every scroll into history kicked off fetches that grew rows
    // under the reader — and needed the list to keep correcting its own scroll position.
    // A read must be a read.
    const entry = useLinkPreview('https://e.test/page');
    await settle();
    expect(posted).toEqual([]);
    expect(entry.value).toBeNull();
  });

  it('priming is what resolves, and a later read sees the result', async () => {
    primePreviews(['look at https://e.test/page'], BOTH);
    const entry = useLinkPreview('https://e.test/page');
    await settle();
    expect(posted).toEqual([['https://e.test/page']]);
    expect(entry.value?.title).toBe('T');
  });
});

describe('rendering never blocks priming', () => {
  it('a URL that was RENDERED before priming is still primed', async () => {
    // ⚠⚠ Regression guard, and this one shipped broken once: `useLinkPreview` inserts a cache
    // entry as a side effect of being read, and the skip condition was `cache.has(url)` — so a
    // mere render permanently blocked that URL. The failure path was the default one: both
    // settings off → nothing primed → user enables one → rows render and create null entries →
    // no later history page, backlog replay or live message could ever queue them.
    const url = 'https://e.test/rendered-first';
    useLinkPreview(url); // a row renders and reads it
    await settle();
    expect(posted).toEqual([]);

    primePreviews([`look at ${url}`], BOTH);
    await settle();
    expect(posted).toEqual([[url]]);
  });
});

describe('primePreviews', () => {
  it('coalesces a whole batch into one request', async () => {
    // A history page arrives as one batch; it must not become one POST per row.
    primePreviews(['https://e.test/a', 'https://e.test/b', 'https://e.test/c'], BOTH);
    await settle();
    expect(posted.length).toBe(1);
    expect(posted[0]).toHaveLength(3);
  });

  it('asks about a repeated link once across the whole batch', async () => {
    primePreviews(['see https://e.test/x', 'also https://e.test/x'], BOTH);
    await settle();
    expect(posted).toEqual([['https://e.test/x']]);
  });

  it('does not re-ask for something already known', async () => {
    primePreviews(['https://e.test/x'], BOTH);
    await settle();
    posted = [];
    // An overlapping history page, or a re-render, must be free.
    primePreviews(['https://e.test/x'], BOTH);
    await settle();
    expect(posted).toEqual([]);
  });

  it('does nothing at all when both settings are off', async () => {
    primePreviews(['https://e.test/a https://e.test/b.png'], {
      inlineMedia: false,
      linkPreviews: false,
    });
    await settle();
    expect(posted).toEqual([]);
  });

  it('splits a batch past the server cap across requests', async () => {
    primePreviews(
      Array.from({ length: 25 }, (_, i) => `https://e.test/${i}`),
      BOTH,
    );
    await settle();
    expect(posted.length).toBe(2);
    expect(posted[0]).toHaveLength(20);
    expect(posted[1]).toHaveLength(5);
  });

  it('tolerates null and empty bodies', async () => {
    primePreviews([null, undefined, ''], BOTH);
    await settle();
    expect(posted).toEqual([]);
  });
});

describe('re-asking after expiresAt', () => {
  // ⚠⚠ The server splits `unavailable` into a VERDICT (cached, one-hour TTL) and a TRANSIENT
  // refusal (not cached at all, ~15s TTL) — and that split buys nothing unless a client comes
  // back when the short TTL lapses. It didn't: `dropIfExpired` runs only inside `primePreviews`,
  // which is driven by message ingest, and a message already in the store is never ingested
  // again. So a saturated instance blanked a preview for the life of the tab.
  //
  // Fake timers because the shortest honest wait here is the server's own 15 seconds.
  beforeEach(() => {
    vi.useFakeTimers();
    // The backoff is jittered ±25% on purpose (see `jitter`), which makes every deadline in
    // these tests a range. Pinned to the midpoint so the timing assertions can be exact; the
    // jitter itself is asserted separately below, where the randomness is the subject.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => vi.useRealTimers());

  /** Let the coalescing timer fire and the request settle, under fake timers. */
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('re-asks a transient unavailable once its expiresAt has passed, and recovers', async () => {
    respond = transientFor;
    primePreviews(['https://e.test/t'], BOTH);
    await tick(60);
    expect(posted).toEqual([['https://e.test/t']]);

    const entry = useLinkPreview('https://e.test/t');
    expect(entry.value?.status).toBe('unavailable');

    // Nothing should move before the server's own deadline.
    await tick(10_000);
    expect(posted).toHaveLength(1);

    respond = okFor; // the instance stops being saturated
    await tick(10_000);
    expect(posted).toHaveLength(2);
    expect(entry.value?.status).toBe('ok');
    expect(entry.value?.title).toBe('T');
  });

  it('never re-asks a resolved preview, even one with a short TTL', async () => {
    // ⚠ The short TTL is the point. With the 7-day one this assertion would hold whether or not
    // `ok` answers are excluded from the re-ask — it would be a test of the fixture, not of the
    // module. A card that has ALREADY rendered must not become a standing poll when its TTL
    // lapses: the proxy tokens in `src`/`thumb` are an HMAC over the URL and never expire, so
    // there is nothing to refresh. `dropIfExpired` still re-asks on the next ingest.
    respond = (urls) => ({
      previews: urls.map((url) => ({
        url,
        status: 'ok',
        kind: 'page',
        title: 'T',
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
      })),
    });
    primePreviews(['https://e.test/ok'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);
    await tick(10 * 60_000);
    expect(posted).toHaveLength(1);
  });

  it('keeps a re-ask armed when the re-ask itself fails in transport', async () => {
    // `runReask` disarms a URL as it queues it, expecting the ANSWER to re-arm it. A dropped
    // connection is not an answer — so without the transport-failure branch the first blip
    // during a re-ask retires that URL permanently, which is the bug all over again.
    respond = transientFor;
    primePreviews(['https://e.test/blip'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);

    respond = () => {
      throw new Error('offline');
    };
    await tick(20_000);
    expect(posted).toHaveLength(2); // the re-ask went out, and died

    respond = okFor;
    await tick(5 * 60_000);
    expect(posted).toHaveLength(3);
    expect(useLinkPreview('https://e.test/blip').value?.status).toBe('ok');
  });

  it('backs off rather than re-asking every 15s at the server-suggested rate', async () => {
    // The floor doubles per consecutive failure. Without it a saturated instance is re-asked
    // every 15 seconds by every open tab, for as long as the tabs stay open — a client
    // hammering exactly the server that just told it that it was overloaded.
    respond = transientFor;
    primePreviews(['https://e.test/sat'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);

    await tick(16_000); // 1st re-ask, ~15s
    expect(posted).toHaveLength(2);
    await tick(16_000); // 2nd would be here at a flat rate; the floor is now 30s
    expect(posted).toHaveLength(2);
    await tick(16_000);
    expect(posted).toHaveLength(3);
  });

  it('treats a one-hour verdict as an answer, not as something to come back for', async () => {
    // ⚠⚠ The distinction the whole re-ask depends on. The server answers a genuine failure with
    // FAIL_TTL_MS (1h) and a transient refusal with ~15s; re-asking both turns every dead link
    // in the scrollback into an hourly outbound fetch for the life of the tab — and one that is
    // guaranteed to miss the server's own cache, because both deadlines start together.
    respond = (urls) => ({
      previews: urls.map((url) => ({
        url,
        status: 'unavailable',
        kind: 'page',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      })),
    });
    primePreviews(['https://e.test/dead'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);
    await tick(3 * 60 * 60_000); // three hours
    expect(posted).toHaveLength(1);
  });

  it('jitters the re-ask so simultaneous losers do not return as one wave', async () => {
    // The server jitters its transient TTL precisely so that everything refused by one
    // saturation event doesn't come back together. Taking `max(untilExpiry, floor)` against a
    // FIXED floor threw that away and re-synchronised every client onto the same millisecond —
    // a thundering herd aimed at a server that has just reported itself overloaded.
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => (n++ === 0 ? 0 : 1)); // 0.75x, then 1.25x
    respond = transientFor;
    primePreviews(['https://e.test/a https://e.test/b'], BOTH);
    await tick(60);
    expect(posted).toEqual([['https://e.test/a', 'https://e.test/b']]);

    // Answered together, they must not come BACK together: 11.25s and 18.75s.
    await tick(12_000);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(['https://e.test/a']);
    await tick(8_000);
    expect(posted).toHaveLength(3);
    expect(posted[2]).toEqual(['https://e.test/b']);
  });

  it('recovers a row whose batch failed, without orphaning the ref it is watching', async () => {
    // ⚠⚠ Components capture the Ref OBJECT, not the URL, so deleting a cache entry and minting
    // a fresh one on the next ask delivers the answer into an object nothing is watching. The
    // symptom is the nastiest kind: a fresh read reports `ok` while the row on screen stays
    // blank forever, so the cache looks correct from every angle except the one that matters.
    const held = useLinkPreview('https://e.test/held'); // a mounted row takes its ref
    respond = () => {
      throw new Error('offline');
    };
    primePreviews(['https://e.test/held'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);
    expect(held.value).toBeNull();

    respond = okFor;
    await tick(20_000);
    expect(posted).toHaveLength(2);
    // The SAME ref the row is watching must be the one that resolved.
    expect(held.value?.status).toBe('ok');
    expect(useLinkPreview('https://e.test/held')).toBe(held);
  });

  it('re-asks a URL the server silently omitted from an otherwise-fine response', async () => {
    // No error, no verdict, no retry entry, and `asked` still holding it — a URL dropped from
    // the response reached a state every recovery path stepped over. `?? []` on a malformed 200
    // does the same thing to a whole batch at once.
    respond = () => ({ previews: [] });
    primePreviews(['https://e.test/ghost'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);

    respond = okFor;
    await tick(20_000);
    expect(posted).toHaveLength(2);
    expect(useLinkPreview('https://e.test/ghost').value?.status).toBe('ok');
  });
});

describe('is an answer still coming?', () => {
  // ⚠⚠ The distinction the reveal gate in `MessageAttachments` rests on. That component holds a
  // message's whole attachment block back until every URL in it has settled, so it has to tell
  // "in flight" apart from "nobody ever asked" — and only this module knows. Its own suite mocks
  // `usePreviewsSettled`, so this is the ONLY place the real rule is exercised.
  //
  // The gate's first version guessed with a 1500ms timer instead. The guess was wrong by more
  // than an order of magnitude (the server allows 10s of queue wait plus a 30s resolve deadline
  // per URL, answered as one `Promise.all` over the slice), so it fired on any cold link and
  // revealed a partial set — re-creating the very arrangement flip it existed to prevent.

  const urls = (...list: string[]) => ref(list);

  it('says NOT SETTLED while a primed URL is still in flight', async () => {
    let release: (() => void) | undefined;
    respond = (list) =>
      new Promise((resolve) => {
        release = () => resolve(okFor(list));
      });

    const settledRef = usePreviewsSettled(urls('https://e.test/slow'));
    primePreviews(['https://e.test/slow'], BOTH);
    await settle();
    expect(settledRef.value).toBe(false);

    release?.();
    await settle();
    expect(settledRef.value).toBe(true);
  });

  it('says SETTLED for a URL nobody ever primed', () => {
    // ⚠ The property that makes the gate safe. `useLinkPreview` hands back a permanently-null ref
    // for an unprimed URL, so a gate of "every entry has a value" would blank that message for
    // the life of the tab. Not in flight means not coming, so render now.
    expect(usePreviewsSettled(urls('https://e.test/never-primed')).value).toBe(true);
  });

  it('says SETTLED for a failure awaiting a re-ask, rather than holding the message', async () => {
    // A transient refusal has an ANSWER; the re-ask may be minutes out. Treating a queued re-ask
    // as pending would hide a whole message on the strength of one saturated fetch.
    respond = transientFor;
    const settledRef = usePreviewsSettled(urls('https://e.test/transient'));
    primePreviews(['https://e.test/transient'], BOTH);
    await settle();
    expect(useLinkPreview('https://e.test/transient').value?.status).toBe('unavailable');
    expect(settledRef.value).toBe(true);
  });
});
