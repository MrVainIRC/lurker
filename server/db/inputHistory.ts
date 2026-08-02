// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBufferIdByNetwork } from './bufferResolve.js';

// Keyed (user_id, buffer_id) since schema 18. Signatures unchanged — callers
// hold names; resolution happens here. A miss on add is a silent drop (input
// history for a buffer that doesn't exist has nowhere to live and nothing to
// replay it), matching the old behavior of rows nothing would ever read.

const insertStmt = db.prepare(`
  INSERT INTO input_history (user_id, buffer_id, text)
  VALUES (?, ?, ?)
`);

const listRecentStmt = db.prepare(`
  SELECT text FROM input_history
  WHERE user_id = ? AND buffer_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

export function addEntry(userId: number, networkId: number, target: string, text: string): void {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return;
  insertStmt.run(userId, bufferId, text);
}

// Returns the `limit` most recent entries, oldest-first — the order the client
// wants for up-arrow walking (index N-1 is newest, walk backwards toward 0).
// The table itself is uncapped; this slice is just what we ship on snapshot.
export function listRecent(
  userId: number,
  networkId: number,
  target: string,
  limit = 200,
): string[] {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  return (listRecentStmt.all(userId, bufferId, limit) as Array<{ text: string }>)
    .map((row) => row.text)
    .toReversed();
}
