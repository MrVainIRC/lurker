// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Database } from 'better-sqlite3';

// The v17 normalization bodies: mint the buffers rows that message history
// implies, then stamp messages.buffer_id from them. Exported (and handed the
// db) rather than inlined in index.ts for three reasons: index.ts calls them
// at module load mid-evaluation (importing it back would be a cycle — same
// pattern as foldBufferCase/seedUploaderConfig), the import path reuses them
// to normalize v1 archives, and the kill/resume behavior is unit-testable.
//
// Everything here is idempotent and re-runnable: mints are insert-if-absent,
// the backfill only touches `buffer_id IS NULL` rows, and progress persists in
// app_meta inside each chunk's transaction. A watchdog kill mid-run loses at
// most one chunk and the next boot resumes where it left off — the restart
// loop documented on the idx_messages_unread build (a one-shot, non-resumable
// stall) structurally cannot happen here.
//
// Folding: lookups everywhere else fold with JS toLowerCase (buffers.ts
// foldTarget — Unicode-aware), but a set-based UPDATE can only call SQL
// functions, and SQLite's lower() is ASCII-only. `#Ärger` folds differently
// under the two, which is exactly the class of bug #707 catalogues. So the
// SQL side calls a registered custom function that IS foldTarget, and the two
// rules cannot diverge.

const FOLD_FN = 'lurker_fold_target';

export function registerFoldFunction(db: Database): void {
  // Registering the same name twice replaces the implementation — harmless —
  // but wrap anyway so a driver that objects can't turn boot into a crash.
  try {
    db.function(FOLD_FN, { deterministic: true }, (target) =>
      typeof target === 'string' ? target.toLowerCase() : null,
    );
  } catch {
    /* already registered */
  }
}

/**
 * Mint the `:system:` row for every user and the `:server:<netId>` row for
 * every network. These buffers have always existed behaviorally (real
 * buffer_reads rows, real `:server:` message rows, synthesized by wsHub's
 * walk) — the kind enum reserved 'server'/'system' for the day they became
 * real rows, and buffer_id is that day: leaving them rowless would mean the
 * unread path keeps a (network_id, target) index forever just for sentinels.
 *
 * state 'open': they are permanent, uncloseable fixtures (buffers.ts guards
 * close/delete against these kinds).
 */
export function mintSentinelBuffers(db: Database): void {
  // `WHERE true` disambiguates the upsert clause — without it SQLite parses
  // the ON of ON CONFLICT as a join constraint and errors "near DO".
  db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     SELECT u.id, NULL, ':system:', ':system:', 'system', 'open', 0, NULL FROM users u WHERE true
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     SELECT n.user_id, n.id, ':server:' || n.id, ':server:' || n.id, 'server', 'open', 0, NULL
     FROM networks n WHERE true
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  ).run();
}

/**
 * Mint a CLOSED buffers row for every distinct message target that lacks one.
 *
 * The v16 migration derived the registry FROM history, so on a healthy DB this
 * mints nothing. It exists because the alternative on a damaged or hand-edited
 * DB is worse in both directions: dropping the rows loses user data, and
 * leaving them unmatched leaves messages.buffer_id NULL — invisible history.
 * Closed means garbage never surfaces in a sidebar; genuinely-live targets get
 * reopened by their next message through the ordinary reducer.
 *
 * Folding is done in JS (foldTarget parity — see module header), so the
 * distinct targets are materialized and folded here rather than inserted
 * set-based. The distinct list is O(buffers), not O(messages), in size; the
 * scan to produce it is one index-only pass. Materialized with .all() —
 * iterating a live cursor while writing on the shared connection is the
 * documented crash class (AGENTS.md).
 */
export function mintOrphanBuffersFromMessages(db: Database): number {
  const distinct = db
    .prepare(`SELECT DISTINCT network_id AS networkId, target FROM messages`)
    .all() as Array<{ networkId: number; target: string }>;
  if (distinct.length === 0) return 0;

  const userByNetwork = db.prepare(`SELECT user_id AS userId FROM networks WHERE id = ?`);
  const exists = db.prepare(
    `SELECT 1 FROM buffers
     WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     VALUES (?, ?, ?, ?, ?, 'closed', 0, NULL)
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  );

  let minted = 0;
  for (const { networkId, target } of distinct) {
    const owner = userByNetwork.get(networkId) as { userId: number } | undefined;
    if (!owner) continue; // orphaned network row; the FK would reject the mint
    const folded = target.toLowerCase();
    if (exists.get(owner.userId, networkId, folded)) continue;
    // ':'-prefixed strays (a sentinel casing variant, a corrupt import) are
    // minted as 'server' so kindForTarget's channel/dm split never claims them.
    const kind = target.startsWith(':')
      ? 'server'
      : '#&+!'.includes(target[0] ?? '')
        ? 'channel'
        : 'dm';
    minted += insert.run(owner.userId, networkId, target, folded, kind).changes;
  }
  return minted;
}

const CURSOR_KEY = 'messages_bufferid_cursor';
const DONE_KEY = 'messages_bufferid_done';

/** Default rows per chunk. ~25k rows keeps each transaction (and the WAL it
 *  appends) small enough that Litestream replicates increments instead of one
 *  giant gulp, while the whole 2M-row reference account still completes in
 *  well under a hundred transactions. */
export const BACKFILL_CHUNK_ROWS = 25_000;

export interface BackfillResult {
  /** Rows actually stamped by this run (not counting already-done rows). */
  updated: number;
  /** True when the done-flag is set (no NULL buffer_id remains). */
  complete: boolean;
}

/**
 * Stamp messages.buffer_id in resumable, rowid-range chunks.
 *
 * Each chunk is its own IMMEDIATE transaction with the progress cursor written
 * inside it, so any kill leaves a committed prefix and the next call resumes
 * from the cursor. Chunking across transactions would be unsafe on the shared
 * connection if the server were running (another write would join an open
 * transaction) — it is safe here solely because this runs synchronously at
 * module load, before anything else can touch the database. Do not call it
 * from a live server without re-deriving that argument.
 *
 * The subquery's fold uses the registered JS-parity function (module header),
 * and its IFNULL form matches idx_buffers_key so each row costs one index
 * seek. Rows whose target resolves to no buffers row stay NULL — the caller
 * loops mint→backfill and warns if anything survives both.
 */
export function backfillMessagesBufferId(
  db: Database,
  {
    chunk = BACKFILL_CHUNK_ROWS,
    abortAfterChunks,
  }: { chunk?: number; abortAfterChunks?: number } = {},
): BackfillResult {
  registerFoldFunction(db);
  if (getMeta(db, DONE_KEY)) return { updated: 0, complete: true };

  const maxId =
    (db.prepare(`SELECT MAX(id) AS m FROM messages`).get() as { m: number | null }).m ?? 0;
  let cursor = Number(getMeta(db, CURSOR_KEY) ?? 0);
  let updated = 0;
  let chunks = 0;

  const updateStmt = db.prepare(
    `UPDATE messages SET buffer_id = (
       SELECT b.id FROM buffers b
       WHERE b.user_id = (SELECT n.user_id FROM networks n WHERE n.id = messages.network_id)
         AND IFNULL(b.network_id, 0) = messages.network_id
         AND b.target_folded = ${FOLD_FN}(messages.target)
     )
     WHERE id > ? AND id <= ? AND buffer_id IS NULL`,
  );

  const step = db.transaction((lo: number, hi: number) => {
    const n = updateStmt.run(lo, hi).changes;
    setMeta(db, CURSOR_KEY, String(hi));
    return n;
  });

  while (cursor < maxId) {
    const hi = Math.min(cursor + chunk, maxId);
    updated += step.immediate(cursor, hi);
    cursor = hi;
    chunks += 1;
    if (abortAfterChunks !== undefined && chunks >= abortAfterChunks) {
      return { updated, complete: false };
    }
  }

  // The cursor only moves forward, so rows a first pass could not resolve
  // (no buffers row yet) are behind it by the time a re-mint fixes the cause.
  // One full-range sweep picks them up: it touches only `buffer_id IS NULL`
  // rows, which at this point is the (near-empty) straggler set.
  if (db.prepare(`SELECT 1 FROM messages WHERE buffer_id IS NULL LIMIT 1`).get()) {
    const sweep = db.transaction(() => updateStmt.run(0, maxId).changes);
    updated += sweep.immediate();
  }

  const straggler = db.prepare(`SELECT 1 FROM messages WHERE buffer_id IS NULL LIMIT 1`).get();
  if (straggler) return { updated, complete: false };
  const finish = db.transaction(() => {
    setMeta(db, DONE_KEY, '1');
    setMeta(db, CURSOR_KEY, String(maxId));
  });
  finish.immediate();
  return { updated, complete: true };
}

/** Is the messages backfill recorded as complete? (Gates the index swap.) */
export function messagesBackfillDone(db: Database): boolean {
  return !!getMeta(db, DONE_KEY);
}

/**
 * The whole v17 data pass: sentinels, orphans, backfill — looped once more if
 * stragglers survive (a target minted between fold rules can leave a first
 * pass short; the second pass resolves against the fresh mints). Never throws
 * on stragglers: a warn plus an unset done-flag retries next boot, which beats
 * a crash-looping cell (the house rule about throwing at module load).
 */
export function normalizeMessagesBufferIds(
  db: Database,
  opts: { chunk?: number } = {},
): BackfillResult {
  registerFoldFunction(db);
  let result: BackfillResult = { updated: 0, complete: messagesBackfillDone(db) };
  if (result.complete) return result;
  for (let pass = 0; pass < 2; pass += 1) {
    mintSentinelBuffers(db);
    mintOrphanBuffersFromMessages(db);
    result = backfillMessagesBufferId(db, opts);
    if (result.complete) return result;
  }
  console.warn(
    '[db] messages.buffer_id backfill left unresolved rows; will retry next boot. ' +
      'If this repeats, some message targets cannot be minted (orphaned network rows?).',
  );
  return result;
}

function getMeta(db: Database, key: string): string | undefined {
  return (
    db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined
  )?.value;
}

function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
