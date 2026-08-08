// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { Router } from 'express';
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

// Stand-in ircManager so routes can be exercised through their whole gate
// chain — not connected (409), not a member (403), mode gates, and the happy
// paths — without opening real IRC sockets. `makeConn` builds the minimal
// surface the routes read: currentNick, isChannelJoined, channels (name +
// member modes), and network (for fold + fan-out).
interface FakeChannel {
  name: string;
  members: Map<string, { nick: string; modes: string[] }>;
}
interface FakeConn {
  currentNick: string | null;
  isChannelJoined: (c: string) => boolean;
  channels: Map<string, FakeChannel>;
  network: { id: number; host: string; user_id: number };
}

function makeConn(args: {
  nick: string;
  network: { id: number; host: string; user_id: number };
  channels?: Array<{ name: string; modes?: Record<string, string[]> }>;
}): FakeConn {
  const channels = new Map<string, FakeChannel>();
  for (const c of args.channels ?? []) {
    const members = new Map<string, { nick: string; modes: string[] }>();
    for (const [nick, modes] of Object.entries(c.modes ?? {})) {
      members.set(nick.toLowerCase(), { nick, modes });
    }
    channels.set(c.name.toLowerCase(), { name: c.name, members });
  }
  return {
    currentNick: args.nick,
    isChannelJoined: (c: string) => channels.has(c.toLowerCase()),
    channels,
    network: args.network,
  };
}

const fakeManager = {
  conn: null as FakeConn | null,
  all: [] as FakeConn[],
  getConnection(_userId: number, _networkId: number) {
    return this.conn;
  },
  listAllConnections() {
    return this.all;
  },
};

vi.mock('../services/ircManager.js', () => ({ default: fakeManager }));

// The webhook fans presence out through wsHub — spy it so tests can assert the
// frame without dragging the real hub (and its socket state) into the app.
const h = vi.hoisted(() => ({
  fanOutToUser: vi.fn<(userId: number, payload: Record<string, unknown>) => void>(),
}));
vi.mock('../services/wsHub.js', () => ({ fanOutToUser: h.fanOutToUser }));
const fanOutToUser = h.fanOutToUser;

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let network: Network;

const SECRET = 'devsecret-long-enough-for-hs256';

// Turn voice on by populating the env the service reads. Individual tests toggle
// pieces of this to exercise the gates.
function enableVoice() {
  process.env.LURKER_VOICE_ENABLED = 'true';
  process.env.LIVEKIT_WS_URL = 'ws://sfu.test:7880';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = SECRET;
}

const savedEnv = { ...process.env };

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const mod = await import('./voice.js');
  user = createUser('voice-routes-alice');
  network = createNetwork(user.id, {
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;
  // Public router first, exactly like app.ts — the webhook must match before
  // the requireAuth'd router 401s it.
  const combined = Router();
  combined.use(mod.voicePublicRouter);
  combined.use(mod.default);
  app = createTestApp({ '/api/voice': combined });
  agent = await createAuthedAgent(app, user.id);
});

afterEach(() => {
  process.env = { ...savedEnv };
  fakeManager.conn = null;
  fakeManager.all = [];
  fanOutToUser.mockClear();
});

afterAll(() => ctx.cleanup());

function connectedAs(modes: string[]): FakeConn {
  const conn = makeConn({
    nick: 'alice',
    network: { id: network.id, host: network.host, user_id: user.id },
    channels: [{ name: '#dev', modes: { alice: modes, bob: ['o'] } }],
  });
  fakeManager.conn = conn;
  return conn;
}

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

  it('503 beats body validation when voice is disabled (documented gate order)', async () => {
    delete process.env.LURKER_VOICE_ENABLED;
    delete process.env.LIVEKIT_WS_URL;
    const res = await agent.post('/api/voice/token').send({ networkId: network.id });
    expect(res.status).toBe(503);
  });

  it('400 for a missing/invalid networkId', async () => {
    enableVoice();
    const res = await agent.post('/api/voice/token').send({ target: '#dev' });
    expect(res.status).toBe(400);
  });

  it('400 for a missing target (after the instance/network gates)', async () => {
    enableVoice();
    connectedAs([]);
    const res = await agent.post('/api/voice/token').send({ networkId: network.id });
    expect(res.status).toBe(400);
  });

  it('404 for a network the caller does not own (ownership gate)', async () => {
    enableVoice();
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
    connectedAs([]);
    const res = await agent
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#elsewhere' });
    expect(res.status).toBe(403);
  });

  it('mints a token for a joined channel, room keyed on the network HOST', async () => {
    enableVoice();
    connectedAs([]);
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
    connectedAs([]);
    const res = await agent.post('/api/voice/token').send({ networkId: network.id, target: 'Bob' });
    expect(res.status).toBe(200);
    expect(res.body.room).toBe('net-irc.libera.chat-d-alice:bob');
  });

  it('enforces the channel join policy (403 below the bar, 200 at it)', async () => {
    enableVoice();
    const { setPolicy } = await import('../db/voicePolicy.js');
    setPolicy('irc.libera.chat', '#dev', 'voice', 'op');

    connectedAs([]); // no modes → below voiced
    const denied = await agent
      .post('/api/voice/token')
      .send({ networkId: network.id, target: '#dev' });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toContain('voice');

    connectedAs(['v']);
    const ok = await agent.post('/api/voice/token').send({ networkId: network.id, target: '#dev' });
    expect(ok.status).toBe(200);

    setPolicy('irc.libera.chat', '#dev', 'none', 'op'); // reset for later tests
  });
});

describe('voice join policy — GET/PUT /api/voice/policy', () => {
  it('any member may read; unset reads as none', async () => {
    enableVoice();
    connectedAs([]);
    const res = await agent.get(`/api/voice/policy?networkId=${network.id}&target=%23dev`);
    expect(res.status).toBe(200);
    expect(res.body.minJoinMode).toBe('none');
  });

  it('non-ops (including halfops) cannot set policy', async () => {
    enableVoice();
    connectedAs(['h']);
    const res = await agent
      .put('/api/voice/policy')
      .send({ networkId: network.id, target: '#dev', minJoinMode: 'op' });
    expect(res.status).toBe(403);
  });

  it('ops set it; it round-trips through GET and normalizes garbage', async () => {
    enableVoice();
    connectedAs(['o']);
    const put = await agent
      .put('/api/voice/policy')
      .send({ networkId: network.id, target: '#dev', minJoinMode: 'halfop' });
    expect(put.status).toBe(200);
    expect(put.body.minJoinMode).toBe('halfop');

    const got = await agent.get(`/api/voice/policy?networkId=${network.id}&target=%23dev`);
    expect(got.body.minJoinMode).toBe('halfop');

    const garbage = await agent
      .put('/api/voice/policy')
      .send({ networkId: network.id, target: '#dev', minJoinMode: 'sudo' });
    expect(garbage.body.minJoinMode).toBe('none'); // normalized, fails open to anyone
  });

  it('rejects a DM target (policies are channel-scoped)', async () => {
    enableVoice();
    connectedAs(['o']);
    const res = await agent
      .put('/api/voice/policy')
      .send({ networkId: network.id, target: 'bob', minJoinMode: 'op' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/voice/moderate', () => {
  it('403 for non-moderators (voice is not enough)', async () => {
    enableVoice();
    connectedAs(['v']);
    const res = await agent
      .post('/api/voice/moderate')
      .send({ networkId: network.id, target: '#dev', action: 'remove', identity: 'bob' });
    expect(res.status).toBe(403);
  });

  it('400 for a bogus action', async () => {
    enableVoice();
    connectedAs(['o']);
    const res = await agent
      .post('/api/voice/moderate')
      .send({ networkId: network.id, target: '#dev', action: 'defenestrate', identity: 'bob' });
    expect(res.status).toBe(400);
  });

  it('403 for a DM target — moderation is channel-only', async () => {
    enableVoice();
    connectedAs(['o']);
    const res = await agent
      .post('/api/voice/moderate')
      .send({ networkId: network.id, target: 'bob', action: 'remove', identity: 'bob' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/voice/webhook (public, signature-verified)', () => {
  // Build a REAL LiveKit webhook auth header: a JWT signed with the shared
  // secret whose sha256 claim covers the body — the same thing the SFU sends.
  async function signedAuth(body: string): Promise<string> {
    const { AccessToken } = await import('livekit-server-sdk');
    const at = new AccessToken('devkey', SECRET, { identity: '' });
    at.sha256 = createHash('sha256').update(body).digest('base64');
    return at.toJwt();
  }

  function webhookBody(event: string, room: string, identity: string): string {
    return JSON.stringify({ event, room: { name: room }, participant: { identity } });
  }

  it('401 for a missing or forged signature', async () => {
    enableVoice();
    const body = webhookBody('participant_joined', 'net-irc.libera.chat-c-#dev', 'bob');
    const noAuth = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .send(body);
    expect(noAuth.status).toBe(401);

    const forged = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', 'not-a-real-token')
      .send(body);
    expect(forged.status).toBe(401);
  });

  it('fans a verified join out to local accounts in the channel, in their own spelling', async () => {
    enableVoice();
    // Two local accounts on the host: one in #dev, one not.
    const inChannel = makeConn({
      nick: 'alice',
      network: { id: network.id, host: 'irc.libera.chat', user_id: user.id },
      channels: [{ name: '#Dev', modes: { alice: [] } }], // note the spelling
    });
    const elsewhere = makeConn({
      nick: 'carol',
      network: { id: network.id + 1, host: 'irc.libera.chat', user_id: user.id + 1 },
      channels: [{ name: '#other', modes: { carol: [] } }],
    });
    fakeManager.all = [inChannel, elsewhere];

    const body = webhookBody('participant_joined', 'net-irc.libera.chat-c-#dev', 'bob');
    const res = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', await signedAuth(body))
      .send(body);
    expect(res.status).toBe(200);

    expect(fanOutToUser).toHaveBeenCalledTimes(1);
    expect(fanOutToUser).toHaveBeenCalledWith(user.id, {
      kind: 'call-presence',
      networkId: network.id,
      target: '#Dev', // the receiving connection's own wire spelling
      active: true,
      count: expect.any(Number),
    });
  });

  it('broadcasts nothing for DM rooms', async () => {
    enableVoice();
    fakeManager.all = [
      makeConn({
        nick: 'alice',
        network: { id: network.id, host: 'irc.libera.chat', user_id: user.id },
        channels: [{ name: '#dev', modes: { alice: [] } }],
      }),
    ];
    const body = webhookBody('participant_joined', 'net-irc.libera.chat-d-alice:bob', 'bob');
    const res = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', await signedAuth(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(fanOutToUser).not.toHaveBeenCalled();
  });
});
