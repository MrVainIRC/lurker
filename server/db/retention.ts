// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storage side of history retention (lurker-dev/RETENTION_PLAN.md): the dirty-buffer set
// that tells the sweeper where to look, and the two statements it runs. The
// scheduling lives in services/retentionSweeper.ts; this module owns the SQL
// so the statements sit next to the schema they depend on.
//
// Both statements ride idx_messages_buf_unread (buffer_id, id DESC, …) —
// count-based retention needs no new index, which is half the reason it won
// over age-based (the other half is in the plan). The messages_ad trigger
// keeps messages_fts in sync through these deletes, so search never sees a
// pruned row.

import db, { EARLY_PRUNE_TYPES_SQL } from './index.js';

// Buffers that took an insert since the sweeper last looked. In-memory on
// purpose: a restart just means the next boot seeds every buffer dirty and
// re-verifies, which is also what makes the steady sweeper double as the
// backfill when retention is first enabled on an existing database.
const dirtyBuffers = new Set<number>();

export function markBufferDirty(bufferId: number): void {
  dirtyBuffers.add(bufferId);
}

/** Drain the dirty set. The caller owns the snapshot; new inserts during a
 *  sweep land in a fresh set and are picked up next tick. */
export function takeDirtyBuffers(): number[] {
  const out = [...dirtyBuffers];
  dirtyBuffers.clear();
  return out;
}

/** Boot seeding: every buffer is suspect until the sweeper has looked once.
 *  Also the after-import catch-all — imported rows bypass insertMessage, so
 *  nothing else would ever mark their buffers. */
export function seedAllBuffersDirty(): void {
  const rows = db.prepare(`SELECT id FROM buffers`).all() as Array<{ id: number }>;
  for (const row of rows) dirtyBuffers.add(row.id);
}

/** Re-examine one user's buffers — their retention setting changed. */
export function seedUserBuffersDirty(userId: number): void {
  const rows = db.prepare(`SELECT id FROM buffers WHERE user_id = ?`).all(userId) as Array<{
    id: number;
  }>;
  for (const row of rows) dirtyBuffers.add(row.id);
}

const ownerStmt = db.prepare(`SELECT user_id AS userId FROM buffers WHERE id = ?`);

/** The buffer's owning user, or undefined for a buffer deleted since it was
 *  marked dirty (the cascade already took its messages with it). */
export function bufferOwnerId(bufferId: number): number | undefined {
  const row = ownerStmt.get(bufferId) as { userId: number } | undefined;
  return row?.userId;
}

// The newest `capLines`-th row's id: everything strictly below it is over the
// cap. OFFSET walks the buffer's own rows inside the covering index — message
// ids are a single global sequence, so id arithmetic can never answer this
// (see hasMoreThan in db/messages.ts). No row at that offset = the buffer is
// within its cap.
const boundaryStmt = db.prepare(`
  SELECT id FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
`);

export function retentionBoundaryId(bufferId: number, capLines: number): number | undefined {
  const row = boundaryStmt.get(bufferId, capLines - 1) as { id: number } | undefined;
  return row?.id;
}

// One bounded bite of the over-cap tail. Deliberately no ORDER BY in the
// subselect: everything below the boundary goes eventually, so any qualifying
// rows do, and ordering would only add sort work. The NOT EXISTS is the
// bookmark exemption — a bookmarked row below
// the boundary survives as an extra ABOVE the cap (later boundary probes walk
// past it and it never becomes deletable). It is scoped by user_id, not just
// message_id: user_bookmarks has no index on message_id alone, and a buffer
// has exactly one owner who is the only user able to bookmark its rows, so
// the (user_id, message_id) primary key answers the probe as a seek.
const deleteBatchStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m
     WHERE m.buffer_id = ? AND m.id < ?
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub
          WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

/** Delete up to `limit` over-cap rows. Returns the number deleted; a return
 *  below `limit` means this buffer's tail is done. */
export function deleteRetentionBatch(
  bufferId: number,
  boundaryId: number,
  ownerUserId: number,
  limit: number,
): number {
  return deleteBatchStmt.run(bufferId, boundaryId, ownerUserId, limit).changes;
}

// ─── The noise clock ───────────────────────────────────────────────────────

/** Every account, for the per-user noise sweep. Bounded by the user count,
 *  which is small on every edition. */
export function listUserIds(): number[] {
  return (db.prepare(`SELECT id FROM users`).all() as Array<{ id: number }>).map((r) => r.id);
}

// One bounded bite of a user's over-age noise. INDEXED BY is load-bearing
// twice over: (1) this schema never runs ANALYZE, and without the hint the
// planner drives from buffers(user_id) and walks every one of the user's
// buffers row-by-row — the exact shape the search indexes were built to kill;
// (2) SQLite refuses to prepare an INDEXED BY whose partial-index predicate
// the query no longer implies, so widening EARLY_PRUNE_TYPES without
// migrating the index fails the boot loudly instead of silently scanning.
// `time < ?` is a lexicographic compare on the stored ISO-8601 strings, the
// same ordering assumption CHATHISTORY's window queries already rely on
// (db/messages.ts loadHistoryWindow). The NOT EXISTS is the same owner-scoped
// bookmark exemption as the count sweep — and it must be here in the SELECT,
// not just "skipped at delete": an exempt row that stayed a candidate would
// make a batch of survivors read as progress forever.
const noiseDeleteStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m INDEXED BY idx_messages_noise_time
     JOIN buffers b ON b.id = m.buffer_id
     WHERE m.type IN (${EARLY_PRUNE_TYPES_SQL})
       AND m.time < ?
       AND b.user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub
          WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

/** Delete up to `limit` of this user's noise rows older than `cutoffIso`.
 *  A return below `limit` means this user's over-age noise is done. */
export function deleteNoiseBatch(userId: number, cutoffIso: string, limit: number): number {
  return noiseDeleteStmt.run(cutoffIso, userId, userId, limit).changes;
}
