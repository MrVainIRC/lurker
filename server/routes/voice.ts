// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import ircManager from '../services/ircManager.js';
import type { IrcConnection } from '../services/ircConnection.js';
import { isChannelTarget } from '../../shared/channels.js';
import { mintVoiceToken, roomFor, voiceEnabled } from '../services/voice.js';

// Voice control surface. Lurker is the token authority (see services/voice.ts);
// it never carries media. Everything here is requireAuth'd and gated on
// voiceEnabled(), so on a non-voice instance this router is a wall of 503s and
// the client never shows the UI that would call it.

interface CallCtx {
  network: Network;
  conn: IrcConnection;
  nick: string;
}

/** Resolve + gate the common preconditions (voice on, network owned, live
 *  connection). Sends the error response and returns null on any failure. */
function resolveCall(req: Request, res: Response, networkId: number): CallCtx | null {
  if (!voiceEnabled()) {
    res.status(503).json({ error: 'voice not enabled on this server' });
    return null;
  }
  if (!Number.isInteger(networkId) || networkId <= 0) {
    res.status(400).json({ error: 'networkId required' });
    return null;
  }
  const network = getNetwork(networkId, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return null;
  }
  const conn = ircManager.getConnection(req.user!.id, networkId);
  if (!conn || !conn.currentNick) {
    res.status(409).json({ error: 'network not connected' });
    return null;
  }
  return { network, conn, nick: conn.currentNick };
}

const router = Router();
router.use(requireAuth);

// ─── Join: mint a room-scoped token, gated by channel membership ────────────
router.post('/token', async (req: Request, res: Response) => {
  const networkId = Number(req.body?.networkId);
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  if (!target) {
    res.status(400).json({ error: 'target required' });
    return;
  }
  const ctx = resolveCall(req, res, networkId);
  if (!ctx) return;
  const { network, conn, nick } = ctx;

  // Channels require live membership (the one casemapping-correct probe — see
  // isChannelJoined). DMs deliberately don't gate on the peer: opening a DM
  // call IS the invite, exactly like opening a DM buffer.
  if (isChannelTarget(target) && !conn.isChannelJoined(target)) {
    res.status(403).json({ error: 'not a member of that channel' });
    return;
  }

  const room = roomFor(network.host, target, nick);
  try {
    const minted = await mintVoiceToken({ identity: nick, room });
    res.json(minted); // { token, room, url }
  } catch {
    res.status(500).json({ error: 'failed to mint token' });
  }
});

export default router;
