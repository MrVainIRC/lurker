// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin storage stats (lurker-dev/RETENTION_PLAN.md §3.4): the visibility
// half of the abuse story. The plan deliberately ships NO per-account quotas
// — this pane is how the operator finds out whether anyone is actually
// farming buffers before any automated defense gets designed. Mounted under
// routes/admin.ts, so requireAuth + requireAdmin are inherited.
//
// Costs one covering-index walk of the messages table per refresh (a
// per-network COUNT on idx_messages_net, index-only, summed per user) — on
// the 2M-row reference database that is on the order of 100ms of synchronous
// work on the shared connection, so the payload is cached for a minute and
// only an admin opening the pane ever pays it.

import fs from 'fs';
import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { DATABASE_FILE } from '../db/index.js';
import {
  declaredRetentionCeilingLines,
  declaredEventRetentionCeilingHours,
} from '../services/retentionLimits.js';

const router = Router();

// Matches the measured all-in cost (row + indexes + FTS) on the reference
// database; the UI multiplies rows by this and labels the result "≈".
const APPROX_BYTES_PER_ROW = 281;

const CACHE_TTL_MS = 60 * 1000;
let cached: { at: number; payload: Record<string, unknown> } | null = null;

function fileBytes(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function buildPayload(): Record<string, unknown> {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const freelist = db.pragma('freelist_count', { simple: true }) as number;

  const users = db.prepare(`SELECT id, username FROM users ORDER BY id`).all() as Array<{
    id: number;
    username: string;
  }>;
  const networks = db.prepare(`SELECT id, user_id AS userId FROM networks`).all() as Array<{
    id: number;
    userId: number;
  }>;
  const countByNetwork = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE network_id = ?`);
  const buffersByUser = new Map<number, number>(
    (
      db
        .prepare(`SELECT user_id AS userId, COUNT(*) AS n FROM buffers GROUP BY user_id`)
        .all() as Array<{ userId: number; n: number }>
    ).map((r) => [r.userId, r.n]),
  );

  const rowsByUser = new Map<number, number>();
  for (const net of networks) {
    const n = (countByNetwork.get(net.id) as { n: number }).n;
    rowsByUser.set(net.userId, (rowsByUser.get(net.userId) ?? 0) + n);
  }

  return {
    generatedAt: new Date().toISOString(),
    approxBytesPerRow: APPROX_BYTES_PER_ROW,
    database: {
      fileBytes: fileBytes(DATABASE_FILE),
      walBytes: fileBytes(`${DATABASE_FILE}-wal`),
      // Freed pages SQLite will reuse before growing the file — retention's
      // deletes land here, which is why the file stops growing rather than
      // shrinking (no VACUUM runs online, by design).
      reclaimableBytes: freelist * pageSize,
    },
    ceilings: {
      maxLines: declaredRetentionCeilingLines(),
      maxEventHours: declaredEventRetentionCeilingHours(),
    },
    users: users
      .map((u) => ({
        id: u.id,
        username: u.username,
        messageRows: rowsByUser.get(u.id) ?? 0,
        buffers: buffersByUser.get(u.id) ?? 0,
      }))
      .sort((a, b) => b.messageRows - a.messageRows),
  };
}

router.get('/', (_req: Request, res: Response) => {
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    cached = { at: Date.now(), payload: buildPayload() };
  }
  res.json(cached.payload);
});

export default router;
