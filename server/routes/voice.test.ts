// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-voice');

// Stand-in ircManager so the route can be exercised through its whole gate
// chain — not connected (409), not a member (403), and the happy path — without
// opening real IRC sockets. Tests flip `conn` between null and a fake carrying
// exactly the surface the route reads: currentNick + isChannelJoined.
const fakeManager = {
  conn: null as null | { currentNick: string | null; isChannelJoined: (c: string) => boolean },
  getConnection(_userId: number, _networkId: number) {
    return this.conn;
  },
};

vi.mock('../services/ircManager.js', () => ({ default: fakeManager }));

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let network: Network;

// Turn voice on by populating the env the service reads. Individual tests toggle
// pieces of this to exercise the gates.
function enableVoice() {
  process.env.LURKER_VOICE_ENABLED = 'true';
  process.env.LIVEKIT_WS_URL = 'ws://sfu.test:7880';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'devsecret-long-enough';
}

const savedEnv = { ...process.env };

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const router = (await import('./voice.js')).default;
  user = createUser('voice-routes-alice');
  network = createNetwork(user.id, {
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;
  app = createTestApp({ '/api/voice': router });
  agent = await createAuthedAgent(app, user.id);
});

afterEach(() => {
  process.env = { ...savedEnv };
  fakeManager.conn = null;
});

afterAll(() => ctx.cleanup());

describe('POST /api/voice/token', () => {
  it('401 when unauthenticated', async () => {
    enableVoice();
    const res = await testRequest(app)
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(401);
  });

  it('503 when voice is not enabled on the server', async () => {
    delete process.env.LURKER_VOICE_ENABLED;
    delete process.env.LIVEKIT_WS_URL;
    const res = await agent
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(503);
  });

  it('400 for a missing/invalid networkId', async () => {
    enableVoice();
    const res = await agent.post('/api/voice/token').send({ target: '#dev' });
    expect(res.status).toBe(400);
  });

  it('400 for a missing target', async () => {
    enableVoice();
    const res = await agent.post('/api/voice/token').send({ networkId: network.id });
    expect(res.status).toBe(400);
  });

  it('404 for a network the caller does not own (ownership gate)', async () => {
    enableVoice();
    // networkId 999999 belongs to nobody, so getNetwork(id, user) is undefined —
    // the request is refused before any room token can be minted.
    const res = await agent.post('/api/voice/token').send({ networkId: 999999, target: '#dev' });
    expect(res.status).toBe(404);
  });

  it('409 when the network is not connected', async () => {
    enableVoice();
    fakeManager.conn = null;
    const res = await agent
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(409);
  });

  it('403 for a channel the caller has not joined (membership gate)', async () => {
    enableVoice();
    fakeManager.conn = { currentNick: 'alice', isChannelJoined: () => false };
    const res = await agent
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(403);
  });

  it('mints a token for a joined channel, room keyed on the network HOST', async () => {
    enableVoice();
    fakeManager.conn = { currentNick: 'alice', isChannelJoined: (c) => c === '#dev' };
    const res = await agent
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(200);
    expect(res.body.room).toBe('net-irc.libera.chat-c-#dev');
    expect(res.body.url).toBe('ws://sfu.test:7880');
    expect(String(res.body.token).split('.')).toHaveLength(3);
  });

  it('mints a DM token without any membership gate (opening the call IS the invite)', async () => {
    enableVoice();
    fakeManager.conn = { currentNick: 'alice', isChannelJoined: () => false };
    const res = await agent.post('/api/voice/token').send({ networkId: network.id, target: 'Bob' });
    expect(res.status).toBe(200);
    // Canonical sorted pair — Bob's end derives the identical room.
    expect(res.body.room).toBe('net-irc.libera.chat-d-alice:bob');
  });
});
