// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The filesystem backend. Bytes land under the data directory, beside the SQLite
// file and the local uploads that are already there, so a self-hoster who is
// backing up their volume is already backing this up — and losing it costs a
// re-fetch, not data.

import crypto from 'crypto';
import fsSync from 'fs';
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

/**
 * ⚠⚠ Distinguishes GONE from BROKEN, and the distinction is load-bearing.
 *
 * Both are a miss to the caller, so an earlier version collapsed every errno to
 * null — and the caller then forgot the index row for all of them. A transient
 * EMFILE (24 concurrent reads is within this pool's own budget) or an EACCES after
 * a permissions change therefore deleted the row while the object stayed on disk:
 * an orphan eviction can never count and lookup can never find, in a module whose
 * whole premise is that the index is how we know what exists. Only ENOENT means
 * the file is really gone.
 */
export type LocalRead = { kind: 'ok'; body: Buffer } | { kind: 'missing' } | { kind: 'error' };

export async function readLocal(cfg: LocalCacheConfig, key: string): Promise<LocalRead> {
  try {
    return { kind: 'ok', body: await fs.readFile(objectPath(cfg, key)) };
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'error' };
  }
}

/**
 * A write in progress: bytes go to a temp file and are published, or thrown away.
 *
 * ⚠⚠ STREAMED, never buffered. Collecting the object in memory first cost a full
 * copy in `chunks` plus a second at `Buffer.concat`, and the per-request 8 MB
 * ceiling multiplied by `mediaPool`'s 24 slots — ~192 MB steady state and ~384 MB
 * transient, memory the uncached path never allocated at all, reachable by anyone
 * authenticated opening 24 concurrent large images. The destination is a file
 * either way, so there was never a reason for the bytes to sit in RSS on the way
 * there.
 */
export interface LocalWriter {
  write(chunk: Buffer): void;
  /** Publish under the real key. Atomic — a reader sees all of it or none. */
  commit(): Promise<boolean>;
  /** Throw the partial file away. Safe to call twice. */
  abort(): Promise<void>;
}

export async function openLocalWrite(
  cfg: LocalCacheConfig,
  key: string,
): Promise<LocalWriter | null> {
  const target = objectPath(cfg, key);
  // ⚠⚠ RANDOM, not pid+timestamp. Nothing dedupes the byte path — `mediaPool`
  // bounds concurrency, not identity — so several writes of the SAME key can be in
  // flight at once. Two in the same millisecond shared a temp path, and a write
  // truncates only at open: the shorter one left the longer body's tail in place
  // and published a file matching NEITHER, under a row recording the shorter
  // length. Reproduced with 4 MB and 1 MB bodies while this was pid+timestamp.
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  let handle: fsSync.WriteStream;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    handle = fsSync.createWriteStream(tmp);
  } catch {
    return null;
  }
  // A write error (ENOSPC, EROFS) must not become an unhandled 'error' event and
  // take the process down; it is recorded and turns commit into a no-op.
  let broken = false;
  handle.on('error', () => {
    broken = true;
  });

  let done = false;
  const closeStream = () =>
    new Promise<void>((resolve) => {
      handle.end(() => resolve());
    });

  return {
    write(chunk: Buffer): void {
      if (done || broken) return;
      // Backpressure is deliberately not awaited: the response is already being
      // piped to the reader and must not wait on our disk. The stream's own buffer
      // bounds this at the transfer's cap, which is what the memory fix is about.
      handle.write(chunk);
    },
    async commit(): Promise<boolean> {
      if (done) return false;
      done = true;
      await closeStream();
      if (broken) {
        await fs.unlink(tmp).catch(() => {});
        return false;
      }
      try {
        // `rename` within a directory is atomic, so a concurrent read sees either
        // nothing (a miss, which re-fetches) or the whole object — never a prefix,
        // which would be served as a truncated image and held for a day.
        await fs.rename(tmp, target);
        return true;
      } catch {
        await fs.unlink(tmp).catch(() => {});
        return false;
      }
    },
    async abort(): Promise<void> {
      if (done) return;
      done = true;
      await closeStream();
      // ⚠ The temp file is OURS. Left behind it is invisible to the index and
      // therefore to eviction — bytes on the volume nothing counts and nothing can
      // reclaim.
      await fs.unlink(tmp).catch(() => {});
    },
  };
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
