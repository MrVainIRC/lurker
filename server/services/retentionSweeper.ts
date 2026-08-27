// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The background prune loop for history retention (RETENTION_PLAN.md §3.3).
//
// Shape: a self-rescheduling setTimeout chain (not setInterval — a tick that
// found work reschedules itself sooner than one that didn't, TheLounge's
// cadence). Each tick drains the dirty-buffer set fed by insertMessage,
// resolves each buffer owner's effective cap once, and works in small
// discrete statements with a setImmediate yield between them — the shared
// better-sqlite3 connection is synchronous, so the yields are what keep WS
// fan-out and IRC sockets breathing while a large backlog is chewed down.
// The tick budget counts EVERY bounded statement, boundary probes included:
// boot seeds every buffer dirty, so the first tick after start would
// otherwise chain hundreds of O(cap) index walks back-to-back — the exact
// event-loop-starvation class the connect snapshot already had an incident
// with. A tick that runs out of budget re-marks what it didn't finish and
// comes back in seconds rather than minutes; that budget, not a one-shot
// migration, is how first enablement on a big database backfills (and what
// keeps the Litestream WAL churn on hosted cells paced).
//
// Errors: warn and keep going, but stop the loop entirely after three
// consecutive failing ticks (TheLounge's circuit breaker) — a persistent SQL
// error repeating every few seconds forever is worse than pruning stopping,
// which only ever costs disk, never data. The stop is posted to the system
// buffer, not just stdout: an operator has to be able to notice it.

import {
  takeDirtyBuffers,
  markBufferDirty,
  seedAllBuffersDirty,
  seedUserBuffersDirty,
  bufferOwnerId,
  retentionBoundaryId,
  deleteRetentionBatch,
} from '../db/retention.js';
import { listInflightJobs } from '../db/dataExports.js';
import { effectiveRetentionLines } from './retentionLimits.js';
import settingsService from './settingsService.js';
import * as systemLog from './systemLog.js';

export interface RetentionSweepOptions {
  /** Rows per DELETE statement. */
  batchRows: number;
  /** Bounded statements (boundary probes + delete batches) a single tick may
   *  spend before handing the rest to the next one. */
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

  // A with-history export pages the messages table by ascending id with no
  // snapshot isolation (services/exportService.ts) — deleting rows ahead of
  // its cursor would silently hole the archive, and "export your data first"
  // is exactly what the retention setting's own copy tells a user about to
  // lower their cap. Skip the whole tick; the dirty set is untouched, so
  // nothing is forgotten. A crashed job can't wedge this: boot fails orphaned
  // in-flight rows (recoverInterruptedExports).
  if (listInflightJobs().length > 0) return result;

  // Per-tick cap cache: one settings read per owner, not per buffer.
  const capByUser = new Map<number, number>();
  let batchesSpent = 0;

  const pending = takeDirtyBuffers();
  for (let i = 0; i < pending.length; i++) {
    const bufferId = pending[i];
    try {
      if (batchesSpent >= opts.maxBatchesPerTick) {
        // Out of budget — put the rest back for the (soon) next tick.
        markBufferDirty(bufferId);
        result.backlog = true;
        continue;
      }
      // Yield BEFORE the buffer's first statement so no skip path below can
      // chain synchronous work across buffers.
      await yieldToLoop();
      const ownerId = bufferOwnerId(bufferId);
      if (ownerId === undefined) continue; // buffer deleted; cascade got the rows
      let cap = capByUser.get(ownerId);
      if (cap === undefined) {
        cap = effectiveRetentionLines(ownerId);
        capByUser.set(ownerId, cap);
      }
      result.buffersExamined++;
      if (cap <= 0) continue; // unlimited

      // The OFFSET walk is O(cap) index entries — real work, charged like a
      // delete batch.
      const boundaryId = retentionBoundaryId(bufferId, cap);
      batchesSpent++;
      if (boundaryId === undefined) continue; // within cap

      // "Done" is a short delete batch, NOT an exhausted budget: keying the
      // re-mark on the budget livelocks — with a small budget every capped
      // buffer ends its visit at the limit and reports a backlog forever.
      let tailDone = false;
      while (batchesSpent < opts.maxBatchesPerTick) {
        const deleted = deleteRetentionBatch(bufferId, boundaryId, ownerId, opts.batchRows);
        batchesSpent++;
        result.rowsDeleted += deleted;
        if (deleted < opts.batchRows) {
          tailDone = true; // (or only bookmarks left below the boundary)
          break;
        }
        await yieldToLoop();
      }
      if (!tailDone) {
        // Budget died mid-buffer — re-check soon.
        markBufferDirty(bufferId);
        result.backlog = true;
      }
    } catch (err) {
      // Put the in-flight buffer and the undrained remainder back before the
      // throw reaches the caller — a transient error (e.g. SQLITE_BUSY) must
      // not silently drop quiet over-cap buffers from tracking until the
      // next restart.
      for (let j = i; j < pending.length; j++) markBufferDirty(pending[j]);
      throw err;
    }
  }
  return result;
}

let settingsListenerWired = false;

/**
 * Re-examine a user's buffers when their retention setting changes. Without
 * this, a lowered cap only takes effect per-buffer on the next insert or the
 * next restart — and the setting's copy promises deletion, not "deletion,
 * eventually, if the buffer stays active". Exported for tests; idempotent.
 */
export function wireRetentionSettingsListener(): void {
  if (settingsListenerWired) return;
  settingsListenerWired = true;
  settingsService.on('event', ({ userId, changes }) => {
    if (Object.prototype.hasOwnProperty.call(changes, 'data.retention.lines')) {
      seedUserBuffersDirty(userId);
    }
  });
}

let started = false;

export function startRetentionSweeper(
  opts: RetentionSweepOptions = RETENTION_SWEEP_DEFAULTS,
): void {
  if (started) return;
  started = true;
  seedAllBuffersDirty();
  wireRetentionSettingsListener();
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
        systemLog.log({
          level: 'error',
          scope: 'server',
          text:
            'Retention sweeping stopped after 3 consecutive failures; history is ' +
            'no longer being pruned. Restart the server to resume.',
        });
        return;
      }
      schedule(opts.idleDelayMs);
    }
  };
  schedule(opts.idleDelayMs);
}
