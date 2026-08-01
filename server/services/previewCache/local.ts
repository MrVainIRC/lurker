// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The filesystem backend. Bytes land under the data directory, beside the SQLite
// file and the local uploads that are already there, so a self-hoster who is
// backing up their volume is already backing this up — and losing it costs a
// re-fetch, not data.

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { cachedBytes, coldestCached, forget } from '../../db/previewCache.js';
import type { LocalCacheConfig } from './config.js';

/**
 * ⚠ Sharded by the first two characters of the key. One flat directory of a
 * million files is a directory a filesystem walks badly and an operator cannot
 * `ls`; two hex characters give 256 buckets for free, from a key that is already
 * a hex digest.
 */
export function objectPath(cfg: LocalCacheConfig, key: string): string {
  return path.join(cfg.dir, key.slice(0, 2), key);
}

export async function readLocal(cfg: LocalCacheConfig, key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(objectPath(cfg, key));
  } catch {
    // ⚠ Any failure is a MISS, not an error. The index and the disk can disagree —
    // a wiped volume, a half-written file, a permissions change — and every one of
    // those should re-fetch from the origin rather than fail a request for an image.
    return null;
  }
}

export async function writeLocal(
  cfg: LocalCacheConfig,
  key: string,
  body: Buffer,
): Promise<boolean> {
  const target = objectPath(cfg, key);
  // ⚠⚠ RANDOM, not pid+timestamp. Nothing dedupes the byte path — `mediaPool`
  // bounds concurrency, not identity, and the store is fired un-awaited — so
  // several writes of the SAME key can be in flight at once. Two in the same
  // millisecond shared a temp path, and `fs.writeFile` truncates only at open: the
  // shorter write left the longer body's tail in place and published a file
  // matching NEITHER body, under a row recording the shorter length. Reproduced
  // with 4 MB and 1 MB bodies while this was pid+timestamp.
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmp, body);
    // `rename` within a directory is atomic, so a concurrent `readLocal` sees
    // either nothing (a miss, which re-fetches) or the whole object — never a
    // prefix, which would be served as a truncated image and held by a browser
    // for a day.
    await fs.rename(tmp, target);
    return true;
  } catch {
    // ⚠ The temp file is OURS to clean up. Left behind it is invisible to the
    // index and therefore to eviction — bytes on the volume that nothing counts
    // and nothing can ever reclaim.
    await fs.unlink(tmp).catch(() => {});
    return false;
  }
}

/**
 * Remove one object. Reports whether it is actually GONE.
 *
 * ⚠⚠ The boolean is load-bearing, and its absence was a defect. `previewCache.ts`
 * promises a row is forgotten "only for what it actually removed", because the
 * index is the only record of what exists — but a `void` return swallowing every
 * errno made EACCES, EROFS and EBUSY indistinguishable from ENOENT. A volume
 * remounted read-only — which is what a full disk does, i.e. exactly when eviction
 * matters — would have eviction drop rows for files it had not freed, decrement
 * the accounting anyway, and orphan the directory beyond reclaim.
 *
 * ENOENT counts as success: the object is not there, which is what was asked for.
 */
export async function removeLocal(cfg: LocalCacheConfig, key: string): Promise<boolean> {
  try {
    await fs.unlink(objectPath(cfg, key));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

/**
 * Evict coldest-first until the directory is back under its ceiling.
 *
 * ⚠⚠ Called BEFORE the write it makes room for, never after. Gating eviction on a
 * SUCCESSFUL store made it unreachable exactly when it was needed: once the volume
 * fills, every `writeLocal` fails, so the pass that would free space never runs
 * again and the cache stays pinned at full until a human intervenes. Lowering
 * `maxBytes` and restarting had the same wedge — nothing shrinks until the next
 * successful store, which on a full disk never comes. `incoming` is what we are
 * about to add, so the ceiling accounts for it rather than being crossed first.
 *
 * ⚠ Unlinks first, forgets ONLY what it removed, and subtracts from the total only
 * then. The other order leaves a file nothing remembers, which no later pass can
 * find because the index is how we know what exists.
 *
 * ⚠ Bounded per call rather than looping to completion. This runs on the byte
 * path, where a person is waiting for a picture; a cache suddenly far over its
 * ceiling should drain over several requests instead of making one pay for all of
 * it.
 */
const EVICT_BATCH = 64;

export async function evictLocal(cfg: LocalCacheConfig, incoming = 0): Promise<number> {
  let total = cachedBytes('local') + incoming;
  if (total <= cfg.maxBytes) return 0;

  let freed = 0;
  for (const entry of coldestCached('local', EVICT_BATCH)) {
    // ⚠ `continue`, not `break`: one unremovable file (a permissions oddity on a
    // single shard) must not stop the pass from reclaiming everything else.
    if (!(await removeLocal(cfg, entry.key))) continue;
    forget(entry.key);
    total -= entry.size;
    freed++;
    if (total <= cfg.maxBytes) break;
  }
  return freed;
}
