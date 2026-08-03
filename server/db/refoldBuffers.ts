// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { foldTargetWith } from './casemapping.js';
import type { Casemapping } from './casemapping.js';
import { absorbBufferRow } from './renameBuffer.js';

// Re-fold one network's buffer registry under a newly-declared CASEMAPPING
// (#707). Runs when the capture path (ircConnection 'server options') sees a
// declared mapping that differs from what's stored — first contact with a
// declaring server included, since every existing row was folded with the
// legacy Unicode-lowercase rule.
//
// Two things can change:
//
//  - A row's stored fold no longer matches the declared rule (`#Ärger` was
//    folded to `#ärger`; ascii-family rules leave `Ä` alone). Rewritten in
//    place — nothing user-visible, target_folded never leaves the server.
//  - Two rows now fold TOGETHER (`#foo[bar]` and `#foo{bar}` under rfc1459).
//    Merged via the rename machinery's absorb, one buffer-renamed frame per
//    absorbed row (the caller announces) — clients handle it exactly like a
//    DM nick-collision merge.
//
// Survivor choice mirrors what the fold repair has always preferred (see
// foldBufferCase: "the buffer you actually used"): an open row beats a closed
// one, then the row with the most recent message, then the older row id — a
// deterministic tiebreak, not a policy.

export interface RefoldMerge {
  survivorId: number;
  survivorTarget: string;
  absorbedId: number;
  absorbedTarget: string;
  /** Same contract as RenameResult.draftChanged: the surviving draft differs
   *  from what the survivor had before the absorb. */
  draftChanged: boolean;
}

interface Row {
  id: number;
  target: string;
  target_folded: string;
  state: string;
}

// Sentinels (kind server/system) never re-fold — their ':'-prefixed names are
// ours, not the network's.
const rowsStmt = db.prepare(`
  SELECT id, target, target_folded, state FROM buffers
  WHERE user_id = ? AND network_id = ? AND kind IN ('channel', 'dm')
`);
const lastMessageStmt = db.prepare(`SELECT MAX(id) AS m FROM messages WHERE buffer_id = ?`);
const setFoldedStmt = db.prepare(`UPDATE buffers SET target_folded = ? WHERE id = ?`);
const draftBodyStmt = db.prepare(
  `SELECT body FROM user_drafts WHERE user_id = ? AND buffer_id = ?`,
);

const work = db.transaction(
  (userId: number, networkId: number, mapping: Casemapping): RefoldMerge[] => {
    const rows = rowsStmt.all(userId, networkId) as Row[];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const folded = foldTargetWith(mapping, row.target);
      const group = groups.get(folded);
      if (group) group.push(row);
      else groups.set(folded, [row]);
    }

    const merges: RefoldMerge[] = [];
    // Surviving row id → its fold under the new rule.
    const finalFolds: { row: Row; folded: string }[] = [];
    for (const [folded, group] of groups) {
      let survivor = group[0];
      if (group.length > 1) {
        const ranked = group
          .map((row) => ({
            row,
            open: row.state === 'open' ? 1 : 0,
            last: Number((lastMessageStmt.get(row.id) as { m: number | null }).m ?? 0),
          }))
          .sort((a, b) => b.open - a.open || b.last - a.last || a.row.id - b.row.id);
        survivor = ranked[0].row;
        for (const { row: absorbed } of ranked.slice(1)) {
          const before = (draftBodyStmt.get(userId, survivor.id) as { body: string } | undefined)
            ?.body;
          absorbBufferRow(userId, networkId, survivor, absorbed);
          // The union may have opened the survivor; later absorbs in this
          // group must see that, or they'd re-run the flip's subquery dance.
          if (absorbed.state === 'open') survivor.state = 'open';
          const after = (draftBodyStmt.get(userId, survivor.id) as { body: string } | undefined)
            ?.body;
          merges.push({
            survivorId: survivor.id,
            survivorTarget: survivor.target,
            absorbedId: absorbed.id,
            absorbedTarget: absorbed.target,
            draftChanged: after !== before,
          });
        }
      }
      finalFolds.push({ row: survivor, folded });
    }

    // Rewrite drifted folds in two phases, so a one-pass UPDATE order can
    // never trip idx_buffers_key transiently (row A's new fold landing on row
    // B's not-yet-rewritten old fold). Belt-and-braces: for every mapping
    // transition we could construct, such a pair already collides under the
    // OLD fold and merged above — but that's an argument about four specific
    // fold functions, and parking changing rows on a synthetic fold first
    // costs two statements to make the argument unnecessary. `refold:<id>`
    // can't collide with a real fold: DM targets can't contain ':' on the
    // wire and channel folds keep their sigil prefix.
    const changing = finalFolds.filter(({ row, folded }) => row.target_folded !== folded);
    for (const { row } of changing) setFoldedStmt.run(`refold:${row.id}`, row.id);
    for (const { row, folded } of changing) setFoldedStmt.run(folded, row.id);
    return merges;
  },
);

/**
 * Re-fold every buffer of (user, network) under `mapping`, merging rows that
 * now collide. Returns the merges for the caller to announce (one
 * buffer-renamed frame each, merged: true). One IMMEDIATE transaction — it
 * reads before it writes, the Litestream SQLITE_BUSY_SNAPSHOT shape.
 */
export function refoldNetworkBuffers(
  userId: number,
  networkId: number,
  mapping: Casemapping,
): RefoldMerge[] {
  return work.immediate(userId, networkId, mapping);
}
