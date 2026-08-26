// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The restore's per-channel state requests are paced by the server's replies,
// not by a timer: one channel in flight, the next released by the previous
// one's 366 / 331|332 / 324 / 315, with a deadline as the only fallback. Read
// off the wire against the fake ircd — the same shape an ircd's flood control
// judges (see drainRestoreQueue in ircConnection.ts).

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { EngineServer } from '../engine/server.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { EngineLink, engineConfigured } from './engineLink.js';

const SECRET = 'restore-pacing-secret';
const CHANNELS = ['#p1', '#p2', '#p3', '#p4', '#p5', '#p6'];
// This channel's TOPIC is never answered: its step can only end by the deadline.
// (TOPIC, not WHO: irc-framework serialises WHO requests behind their 315, so a
// WHO held back would also wedge every later channel's auto-WHO — a test of the
// framework's queue, not of the pacing.)
const HELD = '#p3';
const DEADLINE_MS = 1500;

let ircd: FakeIrcd;
let engine: EngineServer;
let network: Network;
let userId: number;

// Every line on the wire, in the order it happened: '>' client → server (the
// fake ircd's 'line' event), '<' server → client (the Client's 'raw').
interface Wire {
  t: number;
  dir: '>' | '<';
  line: string;
}
const wire: Wire[] = [];

function until(pred: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() > deadline) {
        const tail = wire
          .slice(-60)
          .map((w) => `${w.dir} ${w.line}`)
          .join('\n');
        return reject(new Error(`timed out waiting for ${what}; last wire lines:\n${tail}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeAll(async () => {
  ircd = await FakeIrcd.start();
  ircd.on('line', (line: string) => wire.push({ t: Date.now(), dir: '>', line }));
  engine = new EngineServer({
    secret: SECRET,
    bufferBytes: 64 * 1024,
    bufferTotalBytes: 1024 * 1024,
    version: 'test',
    log: () => {},
  });
  const { port } = await engine.listen(0, '127.0.0.1');
  process.env.LURKER_ENGINE_URL = `tcp://127.0.0.1:${port}`;
  process.env.LURKER_ENGINE_SECRET = SECRET;
  process.env.LURKER_ENGINE_RETRY_BASE_MS = '100';
  // A full-suite CI run starves the event loop; keep the link's heartbeat well
  // clear of the run so it can't drop a healthy idle link mid-test.
  process.env.LURKER_ENGINE_HEARTBEAT_MS = '600000';
  process.env.LURKER_RESTORE_STEP_DEADLINE_MS = String(DEADLINE_MS);
  EngineLink.resetForTests();
  if (!engineConfigured()) throw new Error('engine mode did not switch on');
  const user = createUser('restore-pacing');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'restore-pacing',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: 'pace',
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  ircManager.shutdown();
  EngineLink.resetForTests();
  await engine.shutdown('tests done', 500);
  await ircd.close();
  delete process.env.LURKER_ENGINE_URL;
  delete process.env.LURKER_ENGINE_SECRET;
  delete process.env.LURKER_ENGINE_RETRY_BASE_MS;
  delete process.env.LURKER_ENGINE_HEARTBEAT_MS;
  delete process.env.LURKER_RESTORE_STEP_DEADLINE_MS;
});

describe('engine restore pacing', () => {
  it("releases each channel on the previous one's replies, and by the deadline when one never comes", async () => {
    // A session with six channels, then the app "restarts".
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    for (const ch of CHANNELS) conn.join(ch);
    await until(() => CHANNELS.every((ch) => conn.isChannelJoined(ch)), 5000, 'joins');
    conn.detach();
    await until(() => conn.state === 'disconnected', 5000, 'detached');

    ircd.hold = (cmd, p) => cmd === 'TOPIC' && (p[0] ?? '').toLowerCase() === HELD;
    const restoreStart = wire.length;
    const conn2 = ircManager.startNetwork(userId, network.id)!;
    conn2.client.on('raw', (ev: { line: string; from_server: boolean }) => {
      if (ev.from_server) wire.push({ t: Date.now(), dir: '<', line: ev.line });
    });
    await until(() => conn2.state === 'connected', 5000, 'reattached');
    const last = CHANNELS[CHANNELS.length - 1];
    await until(
      () => wire.slice(restoreStart).some((w) => w.dir === '<' && numericFor(w.line, '315', last)),
      DEADLINE_MS + 5000,
      "the last channel's WHO answered",
    );

    const since = wire.slice(restoreStart);
    const sentIdx = (line: string) => since.findIndex((w) => w.dir === '>' && w.line === line);
    const sentAt = (line: string) => since[sentIdx(line)].t;
    const gotIdx = (numeric: string, chan: string) =>
      since.findIndex((w) => w.dir === '<' && numericFor(w.line, numeric, chan));

    // Every channel was asked all four things.
    for (const ch of CHANNELS) {
      for (const cmd of ['NAMES', 'TOPIC', 'MODE']) {
        expect(sentIdx(`${cmd} ${ch}`), `${cmd} ${ch}`).toBeGreaterThanOrEqual(0);
      }
      expect(
        since.some((w) => w.dir === '>' && w.line.startsWith(`WHO ${ch}`)),
        `WHO ${ch}`,
      ).toBe(true);
    }

    // The gate: a channel's first request goes out only after the previous
    // channel's last reply came in — all four of them.
    for (let i = 1; i < CHANNELS.length; i++) {
      const prev = CHANNELS[i - 1];
      if (prev === HELD) continue;
      const next = sentIdx(`NAMES ${CHANNELS[i]}`);
      for (const numeric of ['366', '324', '315']) {
        const got = gotIdx(numeric, prev);
        expect(got, `${numeric} ${prev}`).toBeGreaterThanOrEqual(0);
        expect(got, `${numeric} ${prev} before NAMES ${CHANNELS[i]}`).toBeLessThan(next);
      }
      const topic = Math.max(gotIdx('331', prev), gotIdx('332', prev));
      expect(topic, `topic reply ${prev}`).toBeGreaterThanOrEqual(0);
      expect(topic).toBeLessThan(next);
    }

    // The fallback: the held channel's step ends at the deadline, not before —
    // and the steps that were answered did not wait for it.
    const afterHeld = CHANNELS[CHANNELS.indexOf(HELD) + 1];
    expect(Math.max(gotIdx('331', HELD), gotIdx('332', HELD))).toBe(-1);
    const heldWait = sentAt(`NAMES ${afterHeld}`) - sentAt(`NAMES ${HELD}`);
    expect(heldWait).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(heldWait).toBeLessThan(DEADLINE_MS + 1000);
    for (let i = 1; i < CHANNELS.length; i++) {
      if (CHANNELS[i - 1] === HELD) continue;
      const gap = sentAt(`NAMES ${CHANNELS[i]}`) - sentAt(`NAMES ${CHANNELS[i - 1]}`);
      expect(gap, `gap before ${CHANNELS[i]}`).toBeLessThan(DEADLINE_MS / 2);
    }

    // The invariant an ircd's flood control judges: never more than one
    // channel's four requests unanswered at the server. (The held channel's
    // TOPIC is unanswered by construction, so that channel is left out.)
    let outstanding = 0;
    let peak = 0;
    for (const w of since) {
      const m = /^(?:\S+ (?:366|331|332|324|315) \S+ |(?:NAMES|TOPIC|MODE|WHO) )(#p\d)\b/.exec(
        w.line,
      );
      if (!m || m[1] === HELD) continue;
      outstanding += w.dir === '>' ? 1 : -1;
      peak = Math.max(peak, outstanding);
    }
    expect(peak).toBeLessThanOrEqual(4);
  }, 20000);
});

function numericFor(line: string, numeric: string, chan: string): boolean {
  return new RegExp(`^\\S+ ${numeric} \\S+ ${chan}\\b`).test(line);
}
