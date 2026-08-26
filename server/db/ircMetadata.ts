// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { foldTargetFor } from './buffers.js';

export interface IrcMetadataRow {
  networkId: number;
  target: string;
  key: string;
  value: string;
  visibility: string;
}

export function listIrcMetadataForNetwork(networkId: number): IrcMetadataRow[] {
  return db
    .prepare(
      `SELECT network_id AS networkId, target, key, value, visibility
         FROM irc_metadata WHERE network_id = ? ORDER BY target_folded, key`,
    )
    .all(networkId) as IrcMetadataRow[];
}

function folded(networkId: number, target: string): string {
  return foldTargetFor(networkId, target);
}

export function applyIrcMetadata(
  networkId: number,
  target: string,
  key: string,
  value: string | null,
  visibility = '*',
): void {
  if (!networkId || !target || !key) return;
  if (value == null) {
    db.prepare(
      'DELETE FROM irc_metadata WHERE network_id = ? AND target_folded = ? AND key = ?',
    ).run(networkId, folded(networkId, target), key);
    return;
  }
  db.prepare(
    `INSERT INTO irc_metadata (network_id, target, target_folded, key, value, visibility)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(network_id, target_folded, key)
     DO UPDATE SET target = excluded.target, value = excluded.value, visibility = excluded.visibility`,
  ).run(networkId, target, folded(networkId, target), key, value, visibility);
}

export function listIrcMetadata(networkId: number, target: string): IrcMetadataRow[] {
  return db
    .prepare(
      `SELECT network_id AS networkId, target, key, value, visibility
         FROM irc_metadata WHERE network_id = ? AND target_folded = ? ORDER BY key`,
    )
    .all(networkId, folded(networkId, target)) as IrcMetadataRow[];
}
