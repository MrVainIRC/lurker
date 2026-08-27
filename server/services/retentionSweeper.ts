// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The background prune loop for history retention (lurker-dev/RETENTION_PLAN.md §3.3).
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
  listUserIds,
  deleteNoiseBatch,
} from '../db/retention.js';
import { listInflightJobs } from '../db/dataExports.js';
import { effectiveRetentionLines, effectiveEventRetentionHours } from './retentionLimits.js';
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
  /** How often a tick also runs the noise clock (age-based pruning of
   *  EARLY_PRUNE_TYPES). Infinity disables it; 0 runs it every tick. */
  noiseIntervalMs: number;
}

export const RETENTION_SWEEP_DEFAULTS: RetentionSweepOptions = {
  batchRows: 500,
  maxBatchesPerTick: 20,
  idleDelayMs: 60 * 1000,
  busyDelayMs: 5 * 1000,
  noiseIntervalMs: 60 * 60 * 1000,
};

export interface RetentionTickResult {
  buffersExamined: number;
  rowsDeleted: number;
  /** Rows the noise clock deleted (already-aged EARLY_PRUNE_TYPES rows). */
  noiseRowsDeleted: number;
  /** Work remained when the tick's budget ran out. */
  backlog: boolean;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// Noise-clock scheduling state. `lastNoiseSweepMs = 0` makes the first tick
// after boot run the noise phase (budgeted like everything else); the flag is
// set when a user's event_hours setting changes so the change acts within a
// tick instead of within an hour.
let lastNoiseSweepMs = 0;
let noiseSweepDue = false;

/**
 * One sweep pass over the currently-dirty buffers, plus — when due — the
 * noise clock's per-user age sweep. Exported for tests; the production loop
 * below is just this on a timer.
 */
export async function runRetentionTick(
  opts: RetentionSweepOptions = RETENTION_SWEEP_DEFAULTS,
): Promise<RetentionTickResult> {
  const result: RetentionTickResult = {
    buffersExamined: 0,
    rowsDeleted: 0,
    noiseRowsDeleted: 0,
    backlog: false,
  };

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

  // ── The noise clock ──────────────────────────────────────────────────────
  // Per-user, not per-buffer: the cutoff depends only on the owner's setting,
  // and the partial index walks all of a user's over-age noise in one shape.
  // Quiet buffers age out here without ever being dirty — the count sweep
  // can't see them, which is the whole reason this phase exists. Not losable
  // on error the way the dirty set is: due-ness re-derives from the interval.
  if (noiseSweepDue || Date.now() - lastNoiseSweepMs >= opts.noiseIntervalMs) {
    let finished = true;
    for (const userId of listUserIds()) {
      if (batchesSpent >= opts.maxBatchesPerTick) {
        finished = false;
        break;
      }
      const hours = effectiveEventRetentionHours(userId);
      if (hours <= 0) continue; // noise clock off for this user
      const cutoffIso = new Date(Date.now() - hours * 3_600_000).toISOString();
      let userDone = false;
      while (batchesSpent < opts.maxBatchesPerTick) {
        await yieldToLoop();
        const deleted = deleteNoiseBatch(userId, cutoffIso, opts.batchRows);
        batchesSpent++;
        result.noiseRowsDeleted += deleted;
        if (deleted < opts.batchRows) {
          userDone = true; // this user's over-age noise is gone (or bookmarked)
          break;
        }
      }
      if (!userDone) {
        finished = false;
        break;
      }
    }
    if (finished) {
      lastNoiseSweepMs = Date.now();
      noiseSweepDue = false;
    } else {
      noiseSweepDue = true;
      result.backlog = true;
    }
  }

  return result;
}

let settingsListenerWired = false;

/**
 * React to retention settings changes. Without this, a lowered line cap only
 * takes effect per-buffer on the next insert or the next restart — and the
 * settings copy promises deletion, not "deletion, eventually, if the buffer
 * stays active". An event_hours change flags the noise clock due instead:
 * that sweep is per-user, so there is no per-buffer state to seed. Exported
 * for tests; idempotent.
 */
export function wireRetentionSettingsListener(): void {
  if (settingsListenerWired) return;
  settingsListenerWired = true;
  settingsService.on('event', ({ userId, changes }) => {
    if (Object.prototype.hasOwnProperty.call(changes, 'data.retention.lines')) {
      seedUserBuffersDirty(userId);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'data.retention.event_hours')) {
      noiseSweepDue = true;
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
