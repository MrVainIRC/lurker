// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The background prune loop for history retention (RETENTION_PLAN.md §3.3).
//
// Shape: a self-rescheduling setTimeout chain (not setInterval — a tick that
// found work reschedules itself sooner than one that didn't, TheLounge's
// cadence). Each tick drains the dirty-buffer set fed by insertMessage,
// resolves each buffer owner's effective cap once, and deletes the over-cap
// tail in small discrete batches with a setImmediate yield between them — the
// shared better-sqlite3 connection is synchronous, so the yield is what keeps
// WS fan-out and IRC sockets breathing while a large backlog is chewed down.
// A tick that hits its work budget re-marks the unfinished buffer and comes
// back in seconds rather than minutes; that budget, not a one-shot migration,
// is how first enablement on a big database backfills (and what keeps the
// Litestream WAL churn on hosted cells paced).
//
// Errors: warn and keep going, but stop the loop entirely after three
// consecutive failing ticks (TheLounge's circuit breaker) — a persistent SQL
// error repeating every few seconds forever is worse than pruning stopping,
// which only ever costs disk, never data.

import {
  takeDirtyBuffers,
  markBufferDirty,
  seedAllBuffersDirty,
  bufferOwnerId,
  retentionBoundaryId,
  deleteRetentionBatch,
} from '../db/retention.js';
import { effectiveRetentionLines } from './retentionLimits.js';

export interface RetentionSweepOptions {
  /** Rows per DELETE statement. */
  batchRows: number;
  /** Total batches a single tick may spend before yielding to the next one. */
  maxBatchesPerTick: number;
  /** Delay before the next tick when this one finished its whole backlog. */
  idleDelayMs: number;
  /** Delay when the tick ran out of budget with work left. */
  busyDelayMs: number;
}

export const RETENTION_SWEEP_DEFAULTS: RetentionSweepOptions = {
  batchRows: 500,
  maxBatchesPerTick: 20,
  idleDelayMs: 60 * 1000,
  busyDelayMs: 5 * 1000,
};

export interface RetentionTickResult {
  buffersExamined: number;
  rowsDeleted: number;
  /** Work remained when the tick's budget ran out. */
  backlog: boolean;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One sweep pass over the currently-dirty buffers. Exported for tests; the
 * production loop below is just this on a timer.
 */
export async function runRetentionTick(
  opts: RetentionSweepOptions = RETENTION_SWEEP_DEFAULTS,
): Promise<RetentionTickResult> {
  const result: RetentionTickResult = { buffersExamined: 0, rowsDeleted: 0, backlog: false };
  // Per-tick cap cache: one settings read per owner, not per buffer.
  const capByUser = new Map<number, number>();
  let batchesSpent = 0;

  for (const bufferId of takeDirtyBuffers()) {
    if (batchesSpent >= opts.maxBatchesPerTick) {
      // Out of budget — put the rest back for the (soon) next tick.
      markBufferDirty(bufferId);
      result.backlog = true;
      continue;
    }
    const ownerId = bufferOwnerId(bufferId);
    if (ownerId === undefined) continue; // buffer deleted; cascade got the rows
    let cap = capByUser.get(ownerId);
    if (cap === undefined) {
      cap = effectiveRetentionLines(ownerId);
      capByUser.set(ownerId, cap);
    }
    result.buffersExamined++;
    if (cap <= 0) continue; // unlimited

    const boundaryId = retentionBoundaryId(bufferId, cap);
    if (boundaryId === undefined) continue; // within cap

    while (batchesSpent < opts.maxBatchesPerTick) {
      const deleted = deleteRetentionBatch(bufferId, boundaryId, ownerId, opts.batchRows);
      batchesSpent++;
      result.rowsDeleted += deleted;
      if (deleted < opts.batchRows) break; // tail done (or only bookmarks left)
      await yieldToLoop();
    }
    if (batchesSpent >= opts.maxBatchesPerTick) {
      // The last batch came back full — assume more tail and re-check soon.
      markBufferDirty(bufferId);
      result.backlog = true;
    }
    await yieldToLoop();
  }
  return result;
}

let started = false;

export function startRetentionSweeper(
  opts: RetentionSweepOptions = RETENTION_SWEEP_DEFAULTS,
): void {
  if (started) return;
  started = true;
  seedAllBuffersDirty();
  let consecutiveFailures = 0;
  const schedule = (delayMs: number) => {
    setTimeout(() => void tick(), delayMs).unref();
  };
  const tick = async () => {
    try {
      const r = await runRetentionTick(opts);
      consecutiveFailures = 0;
      schedule(r.backlog ? opts.busyDelayMs : opts.idleDelayMs);
    } catch (err) {
      consecutiveFailures++;
      console.warn('[lurker] retention sweep failed:', (err as Error).message);
      if (consecutiveFailures >= 3) {
        console.error(
          '[lurker] retention sweeping STOPPED after 3 consecutive failures; ' +
            'history is no longer being pruned. Restart the server to resume.',
        );
        return;
      }
      schedule(opts.idleDelayMs);
    }
  };
  schedule(opts.idleDelayMs);
}
