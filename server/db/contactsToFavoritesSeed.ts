// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type Database from 'better-sqlite3';
import { normalizeCasemapping, foldTargetWith } from './casemapping.js';

// One-shot v19 migration: convert the Friends/Contacts registry into buffer
// favorites, then drop the contacts tables. A friend becomes their primary
// target's DM buffer, favorited — minted open if they were never conversed
// with, reopened if the DM was closed — so no friend is silently lost in the
// swap. Ordering: alphabetical by contact display name (the order the old
// FRIENDS section rendered), appended after any favorites that already exist
// (there are none at v19, but the seed must be safe to re-run after a partial
// failure). Multi-target contacts contribute one favorite per network (their
// primary there); non-primary alts are part of the complexity the feature
// drop deliberately sheds.
//
// Receives `db` instead of importing it — this runs during db/index.ts module
// evaluation, so importing buffers.ts (which imports db/index.js) would cycle.
// Folding therefore goes through the pure casemapping helpers against the
// network's declared CASEMAPPING token, the same rule foldTargetFor applies:
// getting the fold wrong here would either fail to find an existing buffer
// (and mint a case-twin the next refold pass would have to merge) or write a
// target_folded the unique index disagrees with.
export function seedFavoritesFromContacts(db: Database.Database): number {
  const primaries = db
    .prepare(
      `SELECT c.user_id AS userId, t.network_id AS networkId, t.nick AS nick
       FROM contacts c
       JOIN contact_targets t ON t.contact_id = c.id AND t.is_primary = 1
       ORDER BY c.user_id ASC, c.display_name COLLATE NOCASE ASC, c.id ASC, t.network_id ASC`,
    )
    .all() as Array<{ userId: number; networkId: number; nick: string }>;

  const casemappingStmt = db.prepare(`SELECT casemapping FROM networks WHERE id = ?`);
  const findBufferStmt = db.prepare(
    `SELECT id, state FROM buffers
     WHERE user_id = ? AND IFNULL(network_id, 0) = ? AND target_folded = ?`,
  );
  const reopenStmt = db.prepare(`UPDATE buffers SET state = 'open', closed_at = NULL WHERE id = ?`);
  const mintStmt = db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin)
     VALUES (?, ?, ?, ?, 'dm', 'open', 0)`,
  );
  const nextPositionStmt = db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM favorite_buffers WHERE user_id = ?`,
  );
  const insertFavoriteStmt = db.prepare(
    `INSERT OR IGNORE INTO favorite_buffers (user_id, buffer_id, position) VALUES (?, ?, ?)`,
  );

  let seeded = 0;
  for (const { userId, networkId, nick } of primaries) {
    const raw = (nick || '').trim();
    // A channel-shaped or sentinel "nick" can't have been a real DM target;
    // skip rather than mint a mis-kinded buffer.
    if (!raw || raw.startsWith(':') || /^[#&+!]/.test(raw)) continue;
    const mappingRow = casemappingStmt.get(networkId) as { casemapping: string | null } | undefined;
    if (!mappingRow) continue; // network row gone mid-migration; nothing to favorite
    const folded = foldTargetWith(normalizeCasemapping(mappingRow.casemapping), raw);

    const existing = findBufferStmt.get(userId, networkId, folded) as
      | { id: number; state: string }
      | undefined;
    let bufferId: number;
    if (existing) {
      if (existing.state !== 'open') reopenStmt.run(existing.id);
      bufferId = existing.id;
    } else {
      bufferId = Number(mintStmt.run(userId, networkId, raw, folded).lastInsertRowid);
    }

    const { next } = nextPositionStmt.get(userId) as { next: number };
    seeded += Number(insertFavoriteStmt.run(userId, bufferId, next).changes);
  }

  db.exec(`DROP TABLE IF EXISTS contact_targets`);
  db.exec(`DROP TABLE IF EXISTS contacts`);
  return seeded;
}
