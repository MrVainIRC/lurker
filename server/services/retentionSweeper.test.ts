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
// not hundreds of thousands.
const OPTS = { batchRows: 4, maxBatchesPerTick: 100, idleDelayMs: 0, busyDelayMs: 0 };

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
    expect(first.rowsDeleted).toBe(8); // 2 budgeted batches of 4

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
});
