// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration tests for the retention sweep: real inserts through
// insertMessage (which feeds the dirty set), real deletes through
// runRetentionTick, assertions against the real messages + messages_fts
// tables. Batch/budget constants are INJECTED tiny — test cost must never
// scale with the production constants.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let addBookmark: typeof import('../db/bookmarks.js').addBookmark;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let runRetentionTick: typeof import('./retentionSweeper.js').runRetentionTick;
let takeDirtyBuffers: typeof import('../db/retention.js').takeDirtyBuffers;

beforeAll(async () => {
  ({ default: db } = await import('../db/index.js'));
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ addBookmark } = await import('../db/bookmarks.js'));
  ({ setUserSetting } = await import('../db/settings.js'));
  ({ runRetentionTick } = await import('./retentionSweeper.js'));
  ({ takeDirtyBuffers } = await import('../db/retention.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Tiny knobs so the budget/backlog behavior is exercised with dozens of rows,
// not hundreds of thousands. noiseIntervalMs Infinity keeps the noise clock
// out of the count-sweep tests; the noise tests pass 0 to force it.
const OPTS = {
  batchRows: 4,
  maxBatchesPerTick: 100,
  idleDelayMs: 0,
  busyDelayMs: 0,
  noiseIntervalMs: Infinity,
};

const BASE = Date.parse('2026-08-26T00:00:00Z');

/** A user with their own network and `count` chat lines in #chan. Returns the
 *  ascending message ids and the buffer id they landed in. Each line's first
 *  word is `<name-sans-punctuation><i>` — unique across the whole test file,
 *  so an FTS hit count can never bleed in from another test's buffer. */
function seedBuffer(
  name: string,
  count: number,
): { userId: number; ids: number[]; bufferId: number } {
  const user = createUser(name);
  const net = createNetwork(user.id, { name, host: 'h', port: 6697, tls: true, nick: name });
  const word = name.replace(/[^a-z0-9]/g, '');
  const ids: number[] = [];
  let bufferId = 0;
  for (let i = 0; i < count; i++) {
    const r = insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date(BASE + i * 1000).toISOString(),
      type: 'message',
      nick: 'someone',
      text: `${word}${i} filler`,
      self: false,
    });
    ids.push(Number(r.id));
    bufferId = r.bufferId;
  }
  return { userId: user.id, ids, bufferId };
}

function rowIds(bufferId: number): number[] {
  return (
    db
      .prepare(`SELECT id FROM messages WHERE buffer_id = ? ORDER BY id ASC`)
      .all(bufferId) as Array<{ id: number }>
  ).map((r) => r.id);
}

function ftsHits(word: string): number {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`)
    .pluck()
    .get(word) as number;
}

describe('runRetentionTick', () => {
  it('leaves an uncapped buffer alone', async () => {
    const { bufferId } = seedBuffer('ret-uncapped', 8);
    const result = await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toHaveLength(8);
    expect(result.backlog).toBe(false);
  });

  it('prunes to exactly the cap, keeping the newest rows, FTS included', async () => {
    const { userId, ids, bufferId } = seedBuffer('ret-capped', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    expect(ftsHits('retcapped3')).toBe(1);

    const result = await runRetentionTick(OPTS);

    expect(result.rowsDeleted).toBe(20);
    expect(rowIds(bufferId)).toEqual(ids.slice(20));
    // The delete trigger kept the external-content FTS table in step: a word
    // that only ever appeared in a pruned row is unfindable, a retained one
    // still hits.
    expect(ftsHits('retcapped3')).toBe(0);
    expect(ftsHits('retcapped29')).toBe(1);
  });

  it('a bookmarked row survives pruning as an extra above the cap', async () => {
    const { userId, ids, bufferId } = seedBuffer('ret-bookmark', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    expect(addBookmark(userId, ids[2])).toBe(true);

    await runRetentionTick(OPTS);

    expect(rowIds(bufferId)).toEqual([ids[2], ...ids.slice(20)]);

    // Steady state: with no new inserts the saved row is never deletable and
    // repeat ticks change nothing.
    const { markBufferDirty } = await import('../db/retention.js');
    markBufferDirty(bufferId);
    const again = await runRetentionTick(OPTS);
    expect(again.rowsDeleted).toBe(0);
    expect(rowIds(bufferId)).toEqual([ids[2], ...ids.slice(20)]);
  });

  it('a budget-exhausted tick reports backlog and later ticks finish the job', async () => {
    const { userId, ids, bufferId } = seedBuffer('ret-budget', 30);
    setUserSetting(userId, 'data.retention.lines', 5);

    const first = await runRetentionTick({ ...OPTS, maxBatchesPerTick: 2 });
    expect(first.backlog).toBe(true);
    expect(first.rowsDeleted).toBe(4); // the boundary probe spends 1, one batch of 4 spends the other

    let guard = 0;
    let backlog = true;
    while (backlog) {
      if (++guard > 10) throw new Error('sweep never converged');
      backlog = (await runRetentionTick({ ...OPTS, maxBatchesPerTick: 2 })).backlog;
    }
    expect(rowIds(bufferId)).toEqual(ids.slice(25));
  });

  it('a tick drains the dirty set; only inserts refill it', async () => {
    const { bufferId } = seedBuffer('ret-dirty', 3);
    // Everything seeded above (and here) is pending until a tick runs…
    expect(takeDirtyBuffers()).toContain(bufferId);
    // …and takeDirtyBuffers drained it, so a tick now examines nothing.
    const result = await runRetentionTick(OPTS);
    expect(result.buffersExamined).toBe(0);
  });

  it('changing the cap in settings re-marks the user’s buffers without new traffic', async () => {
    const { wireRetentionSettingsListener } = await import('./retentionSweeper.js');
    const settingsService = (await import('./settingsService.js')).default;
    const { userId, bufferId } = seedBuffer('ret-setting', 12);

    // Drain the seeding inserts so only the settings write can re-mark.
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toHaveLength(12);

    // The settings write alone must re-mark the user's buffers — the copy
    // promises deletion, not "deletion once the buffer next sees traffic".
    // 1000 is the smallest nonzero value validate() accepts (minNonzero);
    // the prune math itself is covered above with injected tiny caps.
    wireRetentionSettingsListener();
    const updated = settingsService.update(userId, { 'data.retention.lines': 1000 });
    expect(updated.ok).toBe(true);
    expect(takeDirtyBuffers()).toContain(bufferId);
  });

  it('the noise clock ages out old noise; chat, kicks, recent noise, bookmarks survive', async () => {
    const user = createUser('noise-mix');
    const net = createNetwork(user.id, {
      name: 'noise-mix',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const old = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const recent = new Date().toISOString();
    const row = (type: string, time: string, text: string) => {
      const r = insertMessage({
        networkId: net!.id,
        target: '#chan',
        time,
        type,
        nick: 'someone',
        text,
        self: false,
      });
      return { id: Number(r.id), bufferId: r.bufferId };
    };
    const oldChat = row('message', old, 'kept chat');
    const oldKick = row('kick', old, 'kept kick');
    const oldTopic = row('topic', old, 'kept topic');
    const doomed = ['join', 'quit', 'motd', 'mode', 'away'].map((t) => row(t, old, `${t} noise`));
    const savedQuit = row('quit', old, 'bookmarked noise');
    const recentJoin = row('join', recent, 'recent noise');
    expect(addBookmark(user.id, savedQuit.id)).toBe(true);
    setUserSetting(user.id, 'data.retention.event_hours', 24);

    const result = await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(result.noiseRowsDeleted).toBe(doomed.length);
    expect(rowIds(oldChat.bufferId)).toEqual(
      [oldChat, oldKick, oldTopic, savedQuit, recentJoin].map((r) => r.id),
    );
  });

  it('the noise clock is ON by default: an untouched user loses week-old noise', async () => {
    const user = createUser('noise-default');
    const net = createNetwork(user.id, {
      name: 'noise-default',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const seed = (time: string) =>
      insertMessage({
        networkId: net!.id,
        target: '#chan',
        time,
        type: 'join',
        nick: 'someone',
        text: null,
        self: false,
      });
    const oldJoin = seed(new Date(Date.now() - 10 * 24 * 3_600_000).toISOString());
    const freshJoin = seed(new Date(Date.now() - 3_600_000).toISOString());

    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(rowIds(oldJoin.bufferId)).toEqual([Number(freshJoin.id)]);
  });

  it('event_hours 0 turns the noise clock off for that user', async () => {
    const user = createUser('noise-off');
    const net = createNetwork(user.id, {
      name: 'noise-off',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    setUserSetting(user.id, 'data.retention.event_hours', 0);
    const r = insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
      type: 'quit',
      nick: 'someone',
      text: 'ancient',
      self: false,
    });

    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(rowIds(r.bufferId)).toEqual([Number(r.id)]);
  });

  it('changing event_hours flags the noise clock due without waiting for the interval', async () => {
    const { wireRetentionSettingsListener } = await import('./retentionSweeper.js');
    const settingsService = (await import('./settingsService.js')).default;
    const user = createUser('noise-flag');
    const net = createNetwork(user.id, {
      name: 'noise-flag',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const r = insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(),
      type: 'part',
      nick: 'someone',
      text: null,
      self: false,
    });

    // Interval Infinity: only the settings-change flag can trigger the phase.
    wireRetentionSettingsListener();
    expect(settingsService.update(user.id, { 'data.retention.event_hours': 24 }).ok).toBe(true);
    await runRetentionTick(OPTS);

    expect(rowIds(r.bufferId)).toEqual([]);
  });

  it('a noise pass under budget resumes where it stopped instead of restarting', async () => {
    // Three fresh users, one old noise row each. With a budget of 2 the pass
    // MUST span ticks: the pre-fix code restarted from the first user every
    // tick, so once users outnumbered the budget the tail was never pruned
    // and backlog never cleared.
    const seeded = ['noise-q1', 'noise-q2', 'noise-q3'].map((name) => {
      const u = createUser(name);
      const net = createNetwork(u.id, { name, host: 'h', port: 6697, tls: true, nick: 'n' });
      const r = insertMessage({
        networkId: net!.id,
        target: '#chan',
        time: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(),
        type: 'join',
        nick: 'x',
        text: null,
        self: false,
      });
      return { bufferId: r.bufferId };
    });

    let guard = 0;
    let backlog = true;
    while (backlog) {
      if (++guard > 30) throw new Error('noise pass never converged');
      backlog = (await runRetentionTick({ ...OPTS, noiseIntervalMs: 0, maxBatchesPerTick: 2 }))
        .backlog;
    }
    for (const s of seeded) expect(rowIds(s.bufferId)).toEqual([]);
  });

  it('replayed noise below the cursor rewinds it and still gets swept', async () => {
    // Stored times may lie in the past (server-time tags, bouncer replay), so
    // a noise row can be INSERTED below the low-water mark a completed pass
    // left behind — territory the sweep believes is already clear. The
    // insert-side rewind is what keeps the "deleted once older than N hours"
    // promise for those rows.
    const user = createUser('noise-replay');
    const net = createNetwork(user.id, {
      name: 'noise-replay',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const row = (time: string) =>
      insertMessage({
        networkId: net!.id,
        target: '#chan',
        time,
        type: 'quit',
        nick: 'x',
        text: null,
        self: false,
      });
    // A completed pass advances this user's cursor to their 168h-default cutoff.
    const fresh = row(new Date().toISOString());
    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
    expect(rowIds(fresh.bufferId)).toEqual([Number(fresh.id)]);

    // Replay lands a rows-old quit BELOW that cursor…
    const replayed = row(new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
    // …and the next pass still deletes it.
    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
    expect(rowIds(fresh.bufferId)).toEqual([Number(fresh.id)]);
    expect(rowIds(replayed.bufferId)).not.toContain(Number(replayed.id));
  });

  it('an in-flight export pauses the sweep without losing the dirty set', async () => {
    const { createExportJob, deleteJob } = await import('../db/dataExports.js');
    const { userId, ids, bufferId } = seedBuffer('ret-export', 12);
    setUserSetting(userId, 'data.retention.lines', 5);

    const job = createExportJob(userId, true);
    const paused = await runRetentionTick(OPTS);
    expect(paused.buffersExamined).toBe(0);
    expect(paused.rowsDeleted).toBe(0);
    expect(rowIds(bufferId)).toHaveLength(12);

    // Job gone → the untouched dirty set prunes on the very next tick.
    deleteJob(job.id);
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toEqual(ids.slice(7));
  });
});
