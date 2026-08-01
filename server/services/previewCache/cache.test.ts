// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The cache as the route uses it: store, then look up, and everything that can
// go wrong in between. Against a real database and a real directory — the index
// and the bytes living in two places IS the design, so a suite that mocked
// either half would be testing neither.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from '../../test-utils/testApp.js';

// ⚠ Delegates to the real module until `dbThrows` is set, so every other test in
// this file runs against a real database and only the fail-soft case sees a
// failure. Patching `db.prepare` used to do this job and stopped working the day
// the statements were hoisted to module scope — which is exactly right for the
// hot path, and left the test asserting nothing.
let dbThrows = false;
vi.mock('../../db/previewCache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/previewCache.js')>();
  const boom = () => {
    throw new Error('SQLITE_BUSY: database is locked');
  };
  return {
    ...actual,
    lookupCached: (key: string) => (dbThrows ? boom() : actual.lookupCached(key)),
    recordCached: (entry: Parameters<typeof actual.recordCached>[0]) =>
      dbThrows ? boom() : actual.recordCached(entry),
    cachedBytes: (backend: string) => (dbThrows ? boom() : actual.cachedBytes(backend)),
  };
});

const ctx = setupTestDb('preview-cache');
const CACHE_DIR = path.join(ctx.tmpDir, 'preview-cache');

let mod: typeof import('./index.js');
let dbmod: typeof import('../../db/previewCache.js');

beforeAll(async () => {
  process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
  process.env.LURKER_PREVIEW_CACHE_DIR = CACHE_DIR;
  // Two 1 KB objects fit; the third forces an eviction.
  process.env.LURKER_PREVIEW_CACHE_MAX_BYTES = '2048';
  await import('../../db/index.js');
  dbmod = await import('../../db/previewCache.js');
  mod = await import('./index.js');
});

afterAll(() => {
  delete process.env.LURKER_PREVIEW_CACHE_MODE;
  delete process.env.LURKER_PREVIEW_CACHE_DIR;
  delete process.env.LURKER_PREVIEW_CACHE_MAX_BYTES;
  ctx.cleanup();
});

beforeEach(async () => {
  const { default: db } = await import('../../db/index.js');
  db.prepare('DELETE FROM preview_cache').run();
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  mod.resetCacheConfigForTests();
});

const bytes = (n: number, fill = 0x61) => Buffer.alloc(n, fill);

describe('preview byte cache — local', () => {
  it('stores bytes and gives them back verbatim', async () => {
    const body = bytes(1024, 0x7f);
    expect(await mod.store('a'.repeat(64), body, 'image/png')).toBe(true);

    const hit = await mod.lookup('a'.repeat(64));
    expect(hit?.kind).toBe('buffer');
    if (hit?.kind !== 'buffer') throw new Error('unreachable');
    // ⚠ Byte equality, not length. A cache that returns the right NUMBER of wrong
    // bytes is worse than one that misses, and it would render as a broken image
    // that the browser then holds for a day.
    expect(hit.body.equals(body)).toBe(true);
    expect(hit.contentType).toBe('image/png');
  });

  it('shards the directory instead of piling everything in one', async () => {
    // A million files in one directory is a directory a filesystem walks badly and
    // an operator cannot list. Two hex characters cost nothing from a key that is
    // already a digest.
    const { objectPath } = await import('./local.js');
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    const key = 'ab' + 'c'.repeat(62);
    expect(path.dirname(objectPath(cfg, key))).toBe(path.join(CACHE_DIR, 'ab'));
  });

  it('MISSES when the index says yes but the bytes are gone, and repairs itself', async () => {
    // ⚠⚠ The state this design has to survive: the row and the file live in
    // different places, so a wiped volume, a restored backup or a manual `rm`
    // leaves rows that claim a hit. Without the repair, every one of them costs a
    // failed read before the origin fetch that was going to happen anyway — forever,
    // because nothing else ever revisits the row.
    const key = 'd'.repeat(64);
    await mod.store(key, bytes(512), 'image/gif');
    expect(dbmod.countCached()).toBe(1);

    fs.rmSync(CACHE_DIR, { recursive: true, force: true });

    expect(await mod.lookup(key)).toBeNull();
    expect(dbmod.countCached()).toBe(0);
  });

  it('evicts the coldest entry once the ceiling is passed', async () => {
    // Ceiling is 2048; three 1 KB objects cannot all fit.
    await mod.store('1'.repeat(64), bytes(1024), 'image/png');
    await mod.store('2'.repeat(64), bytes(1024), 'image/png');
    expect(dbmod.cachedBytes('local')).toBe(2048);

    await mod.store('3'.repeat(64), bytes(1024), 'image/png');

    // ⚠⚠ EXACTLY two, not "fewer than three". `toBeLessThan(3)` could not tell
    // "evicted the one it had to" from "evicted two" — changing the loop's `<=` to
    // `<` over-evicts by one and left the suite green, which is a cache throwing
    // away a live entry on every store once it is near its ceiling.
    expect(dbmod.countCached()).toBe(2);
    expect(dbmod.cachedBytes('local')).toBe(2048);
    // ⚠ The budget, not a named victim: `last_access` has one-second resolution and
    // these are written in the same tick, so which of the first two is coldest is
    // genuinely a tie — demanding a specific key would assert SQLite's tie-break.
    // The newest surviving is the only ordering guarantee that matters.
    expect(await mod.lookup('3'.repeat(64))).not.toBeNull();
  });

  it('leaves no file behind for an entry it evicted', async () => {
    for (const n of ['1', '2', '3', '4']) await mod.store(n.repeat(64), bytes(1024), 'image/png');
    const onDisk: string[] = [];
    for (const shard of fs.readdirSync(CACHE_DIR)) {
      for (const f of fs.readdirSync(path.join(CACHE_DIR, shard))) onDisk.push(f);
    }
    // ⚠ Files and rows must agree. Unlinking after forgetting the row would leak a
    // file nothing remembers, and nothing could ever find it again — the index IS
    // how we know what exists.
    expect(onDisk.length).toBe(dbmod.countCached());
    // ...and no temp files survived either.
    expect(onDisk.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('forgets, not just skips, a row left by another backend', async () => {
    // ⚠ A row whose backend no longer matches is unreachable AND uncounted if it is
    // merely skipped — its bytes sit on the volume forever with nothing able to name
    // them, because the index is how we know what exists. Dropping the row is what
    // lets a later store reclaim the space.
    const key = 'e'.repeat(64);
    await mod.store(key, bytes(64), 'image/png');
    dbmod.recordCached({ key, backend: 'somewhere-else', contentType: 'image/png', size: 64 });
    expect(await mod.lookup(key)).toBeNull();
    expect(dbmod.countCached()).toBe(0);
  });

  it('MISSES a file that is present but the wrong size, and clears it out', async () => {
    // ⚠⚠ `writeLocal` does not fsync before renaming, so a power loss or a killed
    // container can leave a short file under a row that claims the full length.
    // `readFile` succeeds, nothing throws, and the stump would be served with
    // `max-age=86400, immutable` — a permanently broken image every viewer holds for
    // a day. A zero-length Buffer is truthy, so a presence test misses it too.
    const key = 'f'.repeat(64);
    await mod.store(key, bytes(1024), 'image/png');
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    fs.writeFileSync(mod.objectPath(cfg, key), Buffer.alloc(10));

    expect(await mod.lookup(key)).toBeNull();
    expect(dbmod.countCached()).toBe(0);
    expect(fs.existsSync(mod.objectPath(cfg, key))).toBe(false);
  });

  it('never throws out of lookup or store, whatever the database does', async () => {
    // ⚠⚠ The module's headline promise, and it was a CLAIM before it was true.
    // `lookupCached` takes a WAL write lock for its `last_access` touch — proven to
    // block even when it matches zero rows — and a SQLITE_BUSY thrown from there
    // escaped into the route, past a `try` that did not open for another seventy
    // lines, and 500'd an image request that would have succeeded with caching
    // switched off. A cache that can break the thing it accelerates is worse than
    // no cache; the guard belongs in this module, where the promise is made.
    dbThrows = true;
    try {
      await expect(mod.lookup('a'.repeat(64))).resolves.toBeNull();
      await expect(mod.store('b'.repeat(64), bytes(16), 'image/png')).resolves.toBe(false);
    } finally {
      dbThrows = false;
    }
  });
});

describe('preview byte cache — what is worth caching', () => {
  it('takes whole images and refuses everything else', () => {
    expect(mod.cacheable('image/png', false)).toBe(true);
    expect(mod.cacheable('image/webp', false)).toBe(true);
    // ⚠ Video and audio are excluded on purpose: 64 MB against images' 8 MB, and
    // they are read by RANGE, so one seek is many requests for one object and a
    // cached copy would have to answer partial reads. Buffering those per miss
    // trades bandwidth for unbounded memory.
    expect(mod.cacheable('video/mp4', false)).toBe(false);
    expect(mod.cacheable('audio/mpeg', false)).toBe(false);
    expect(mod.cacheable('text/html', false)).toBe(false);
    expect(mod.cacheable(undefined, false)).toBe(false);
    // ⚠ A range request is passed straight through. Serving a whole object to a
    // request that asked for bytes 100-200 is a correctness bug, not a slow path.
    expect(mod.cacheable('image/png', true)).toBe(false);
  });

  it('is off, and answers nothing, when the mode is off', async () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'off';
    mod.resetCacheConfigForTests();
    try {
      expect(mod.cacheEnabled()).toBe(false);
      expect(mod.cacheable('image/png', false)).toBe(false);
      expect(await mod.store('f'.repeat(64), bytes(16), 'image/png')).toBe(false);
      expect(await mod.lookup('f'.repeat(64))).toBeNull();
    } finally {
      process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
      mod.resetCacheConfigForTests();
    }
  });
});
