// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { PreviewRecord } from './linkPreviews.js';

const ctx = setupTestDb('db-link-previews');

let mod: typeof import('./linkPreviews.js');
let db: typeof import('./index.js').default;

beforeAll(async () => {
  mod = await import('./linkPreviews.js');
  db = (await import('./index.js')).default;
});

afterAll(() => ctx.cleanup());

function record(url: string, over: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    url,
    status: 'ok',
    kind: 'page',
    title: 'A Title',
    description: null,
    siteName: null,
    author: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    embedUrl: null,
    mime: null,
    expiresAt: new Date(Date.now() + mod.OK_TTL_MS).toISOString(),
    ...over,
  };
}

describe('expiry', () => {
  it('treats a lapsed row as absent even when it lapsed today', async () => {
    // ⚠ Regression guard. `expires_at` is stored ISO-8601 (`…T11:00:00.000Z`) while
    // `datetime('now')` yields `… 11:00:00`, and SQLite compares TEXT lexicographically where
    // 'T' (0x54) sorts after ' ' (0x20) — so a bare comparison answered "still live" for every
    // expiry on the same calendar date. A one-hour negative TTL survived until midnight UTC.
    const url = 'https://e.test/lapsed';
    mod.putPreview(record(url, { expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(mod.getCachedPreview(url)).toBeNull();

    const live = 'https://e.test/live';
    mod.putPreview(record(live, { expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(mod.getCachedPreview(live)?.title).toBe('A Title');
  });

  it('sweeps only what has lapsed', () => {
    const stale = 'https://e.test/sweep-me';
    mod.putPreview(record(stale, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const fresh = 'https://e.test/keep-me';
    mod.putPreview(record(fresh));

    expect(mod.sweepExpiredPreviews()).toBeGreaterThanOrEqual(1);
    expect(mod.getCachedPreview(stale)).toBeNull();
    expect(mod.getCachedPreview(fresh)?.title).toBe('A Title');
  });

  it('can use the expiry index rather than scanning the table', () => {
    // ⚠⚠ The fix for the comparison above was `datetime(expires_at) <= datetime('now')`, which
    // is correct and NON-SARGABLE: wrapping the column in a function makes
    // idx_link_previews_expires unusable, so the index is maintained on every upsert and read
    // by nothing, and the sweep — which runs at boot and hourly, synchronously, on the one
    // shared connection — becomes a full scan of a table with a 7-day TTL. Asserted through the
    // planner because that is the only thing that actually knows.
    //
    // ⚠⚠ Planned from the module's OWN exported SQL, not a copy of it. Written against a
    // hand-pasted query this test stayed green with the fix reverted — proving only that
    // SQLite can use an index for a string the test made up, which is a comment wearing a
    // test's clothes. It is the shipped statement or it is nothing.
    const planOf = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' ');

    const sweep = planOf(mod.SWEEP_SQL);
    expect(sweep).toContain('idx_link_previews_expires');
    expect(sweep).not.toContain('SCAN link_previews');

    // ...and the form it replaced does not, which is what makes the assertion above mean
    // something rather than restate whatever the planner happens to do.
    const wrapped = planOf(
      `DELETE FROM link_previews WHERE datetime(expires_at) <= datetime('now')`,
    );
    expect(wrapped).toContain('SCAN link_previews');
  });
});

describe('the cache key', () => {
  const urlHash = (url: string): string => mod.urlHash(url);

  it('collapses every form of one URL that normalizeUrl collapses', () => {
    // ⚠ Regression guard. The key was the raw request string with a `/#.*$/` strip, which
    // handled one of these four and left the rest as separate rows — the same page paying for
    // several scrapes, several TTLs, and a one-character cache bypass for anyone authenticated
    // (vary the host's case and every ask is a fresh outbound fetch).
    const canonical = urlHash('https://e.test/a');
    expect(urlHash('https://E.TEST/a')).toBe(canonical); // host case
    expect(urlHash('https://e.test:443/a')).toBe(canonical); // default port
    expect(urlHash('https://e.test/b/../a')).toBe(canonical); // dot segments
    expect(urlHash('https://e.test/a#intro')).toBe(canonical); // fragment
    expect(urlHash('https://e.test/a#appendix')).toBe(canonical);
  });

  it('keeps genuinely different URLs apart', () => {
    const a = urlHash('https://e.test/a');
    expect(urlHash('https://e.test/A')).not.toBe(a); // paths ARE case-sensitive
    expect(urlHash('http://e.test/a')).not.toBe(a); // scheme is part of the identity
    expect(urlHash('https://e.test/a?q=1')).not.toBe(a);
  });

  it('still keys a URL the fetcher refuses outright', () => {
    // normalizeUrl returns null for these, and they still get a negative row — so the fallback
    // has to be the string as asked rather than a crash or a shared bucket.
    expect(urlHash('http://10.0.0.1/x')).not.toBe(urlHash('http://10.0.0.2/x'));
    expect(urlHash('not a url')).toBe(urlHash('not a url'));
  });
});
