// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-refold-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let setNetworkCasemapping: typeof import('./networks.js').setNetworkCasemapping;
let buffers: typeof import('./buffers.js');
let refoldNetworkBuffers: typeof import('./refoldBuffers.js').refoldNetworkBuffers;
let resolveBuffer: typeof import('./bufferResolve.js').resolveBuffer;
let insertMessage: typeof import('./messages.js').insertMessage;
let listMessages: typeof import('./messages.js').listMessages;
let bufferReads: typeof import('./bufferReads.js');
let userId: number;

function makeNetwork(name: string): number {
  return createNetwork(userId, { name, host: 'h', port: 6697, tls: true, nick: 'a' })!.id;
}

function seed(networkId: number, target: string, text: string): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'peer',
      text,
    }).id,
  );
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, setNetworkCasemapping } = await import('./networks.js'));
  buffers = await import('./buffers.js');
  ({ refoldNetworkBuffers } = await import('./refoldBuffers.js'));
  ({ resolveBuffer } = await import('./bufferResolve.js'));
  ({ insertMessage, listMessages } = await import('./messages.js'));
  bufferReads = await import('./bufferReads.js');
  userId = createUser('refold-alice').id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('fold drift without collision', () => {
  it('rewrites target_folded in place under the declared rule', () => {
    const networkId = makeNetwork('drift');
    // Created under the legacy fold: target_folded = '#ärger'.
    buffers.ensureOpen(userId, networkId, '#Ärger');
    const id = buffers.getBuffer(userId, networkId, '#Ärger')!.id;

    setNetworkCasemapping(networkId, 'rfc1459');
    const merges = refoldNetworkBuffers(userId, networkId, 'rfc1459');
    expect(merges).toEqual([]);

    // ascii-family rules leave Ä alone, so the stored fold must now carry it.
    const folded = (
      db.prepare(`SELECT target_folded FROM buffers WHERE id = ?`).get(id) as {
        target_folded: string;
      }
    ).target_folded;
    expect(folded).toBe('#Ärger');
    // And resolution agrees with itself: the raw name still resolves…
    expect(resolveBuffer(userId, networkId, '#Ärger')?.id).toBe(id);
    // …while '#ärger' is now a DIFFERENT name under rfc1459, per the spec.
    expect(resolveBuffer(userId, networkId, '#ärger')).toBeUndefined();
  });

  it('leaves sentinels alone', () => {
    const networkId = makeNetwork('sentinels');
    setNetworkCasemapping(networkId, 'rfc1459');
    refoldNetworkBuffers(userId, networkId, 'rfc1459');
    expect(buffers.getBuffer(userId, networkId, `:server:${networkId}`)).toBeTruthy();
  });
});

describe('newly-colliding rows merge (the #foo[bar] ≡ #foo{bar} fix)', () => {
  it('merges bracket-variant channels; the open row survives a closed one', () => {
    const networkId = makeNetwork('collide');
    // The stale side: closed, but with the NEWER message — open must still win.
    buffers.ensureOpen(userId, networkId, '#foo[bar]');
    buffers.ensureOpen(userId, networkId, '#foo{bar}');
    const bracketId = buffers.getBuffer(userId, networkId, '#foo[bar]')!.id;
    const braceId = buffers.getBuffer(userId, networkId, '#foo{bar}')!.id;
    seed(networkId, '#foo{bar}', 'old chat');
    const bracketMsg = seed(networkId, '#foo[bar]', 'newer chat');
    bufferReads.setReadState(userId, networkId, '#foo[bar]', bracketMsg);
    buffers.close(userId, networkId, '#foo[bar]');

    setNetworkCasemapping(networkId, 'rfc1459');
    const merges = refoldNetworkBuffers(userId, networkId, 'rfc1459');

    expect(merges).toEqual([
      {
        survivorId: braceId,
        survivorTarget: '#foo{bar}',
        absorbedId: bracketId,
        absorbedTarget: '#foo[bar]',
        draftChanged: false,
      },
    ]);
    // One row remains, open, and BOTH spellings resolve to it now.
    expect(resolveBuffer(userId, networkId, '#foo[bar]')?.id).toBe(braceId);
    expect(resolveBuffer(userId, networkId, '#FOO{BAR}')?.id).toBe(braceId);
    expect(buffers.getBuffer(userId, networkId, '#foo{bar}')?.state).toBe('open');
    expect(db.prepare(`SELECT 1 FROM buffers WHERE id = ?`).get(bracketId)).toBeUndefined();
    // Histories interleave on the survivor; the furthest read pointer carried.
    expect(listMessages(networkId, '#foo{bar}').map((m) => m.text)).toEqual([
      'old chat',
      'newer chat',
    ]);
    expect(bufferReads.getReadState(userId, networkId, '#foo{bar}')).toBe(bracketMsg);
  });

  it('between two open rows, the one with the most recent message survives', () => {
    const networkId = makeNetwork('recency');
    buffers.ensureOpen(userId, networkId, 'nick^');
    buffers.ensureOpen(userId, networkId, 'nick~');
    seed(networkId, 'nick^', 'older');
    seed(networkId, 'nick~', 'newest');
    const tildeId = buffers.getBuffer(userId, networkId, 'nick~')!.id;

    setNetworkCasemapping(networkId, 'rfc1459');
    const merges = refoldNetworkBuffers(userId, networkId, 'rfc1459');

    expect(merges).toHaveLength(1);
    expect(merges[0].survivorId).toBe(tildeId);
    expect(resolveBuffer(userId, networkId, 'nick^')?.id).toBe(tildeId);
  });
});

describe('the live paths fold per-network once a mapping is stored', () => {
  it('ensureOpen cannot fork a bracket variant on an rfc1459 network', () => {
    const networkId = makeNetwork('nofork');
    setNetworkCasemapping(networkId, 'rfc1459');
    buffers.ensureOpen(userId, networkId, '#chan[1]');
    const id = buffers.getBuffer(userId, networkId, '#chan[1]')!.id;
    // Pre-#707 this minted a second row; now it lands on the same one.
    buffers.ensureOpen(userId, networkId, '#CHAN{1}');
    expect(buffers.getBuffer(userId, networkId, '#CHAN{1}')?.id).toBe(id);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS c FROM buffers WHERE network_id = ?`).get(networkId) as {
          c: number;
        }
      ).c,
    ).toBe(2); // the channel + the :server: sentinel
  });

  it('an undeclared network keeps the legacy fold — no churn', () => {
    const networkId = makeNetwork('legacy');
    buffers.ensureOpen(userId, networkId, '#foo[bar]');
    buffers.ensureOpen(userId, networkId, '#foo{bar}');
    // No mapping declared: the bracket variants stay distinct, exactly as
    // they always were.
    expect(buffers.getBuffer(userId, networkId, '#foo[bar]')?.id).not.toBe(
      buffers.getBuffer(userId, networkId, '#foo{bar}')?.id,
    );
  });
});
