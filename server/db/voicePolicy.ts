// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

// Per-channel voice-call join policy. Keyed by IRC network host (ASCII-folded)
// + casemapping-folded channel — the same scoping as the LiveKit room name in
// services/voice.ts — so the policy is shared across every user of that channel
// on this instance. min_join_mode is the lowest IRC prefix mode allowed to join
// a call. Set by a channel op (q/a/o, see canAdminCall).

import { normalizeMinJoinMode } from '../../shared/voiceModes.js';
import type { MinJoinMode } from '../../shared/voiceModes.js';

export { normalizeMinJoinMode, isMinJoinMode } from '../../shared/voiceModes.js';
export type { MinJoinMode } from '../../shared/voiceModes.js';

const getStmt = db.prepare(`
  SELECT min_join_mode AS minJoinMode
  FROM voice_channel_policy
  WHERE network_host = ? AND channel_folded = ?
`);

const upsertStmt = db.prepare(`
  INSERT INTO voice_channel_policy
    (network_host, channel_folded, min_join_mode, updated_by)
  VALUES (@host, @channel, @mode, @by)
  ON CONFLICT(network_host, channel_folded) DO UPDATE SET
    min_join_mode = excluded.min_join_mode,
    updated_by = excluded.updated_by,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`);

/** The min join mode for a channel, or 'none' (anyone) when unset. `host` and
 *  `channelFolded` must already be folded (foldKey / foldTargetFor) to match
 *  the room key. */
export function getPolicy(host: string, channelFolded: string): MinJoinMode {
  const row = getStmt.get(host, channelFolded) as { minJoinMode: string } | undefined;
  return normalizeMinJoinMode(row?.minJoinMode);
}

/** Upsert the min join mode for a channel. Returns the stored (normalized) value. */
export function setPolicy(
  host: string,
  channelFolded: string,
  mode: MinJoinMode,
  byNick: string,
): MinJoinMode {
  const m = normalizeMinJoinMode(mode);
  upsertStmt.run({ host, channel: channelFolded, mode: m, by: byNick });
  return m;
}
