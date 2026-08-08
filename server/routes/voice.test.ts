// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
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
  listConnections(_userId: number) {
    return this.conn ? [this.conn] : [];
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
  liveCallCount: vi.fn<(room: string) => Promise<number | null>>(),
}));
vi.mock('../services/wsHub.js', () => ({ fanOutToUser: h.fanOutToUser }));
// Partial mock: liveCallCount queries the SFU over HTTP, which doesn't exist in
// tests — everything else in the voice service runs real.
vi.mock('../services/voice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/voice.js')>()),
  liveCallCount: h.liveCallCount,
}));
const fanOutToUser = h.fanOutToUser;

/** The webhook route acks the SFU BEFORE querying the count + fanning out —
 *  let that post-response async work settle before asserting on it. */
const settle = () => new Promise((r) => setTimeout(r, 20));

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
  h.liveCallCount.mockReset();
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

  it('ops set it and it round-trips through GET', async () => {
    enableVoice();
    connectedAs(['o']);
    const put = await agent
      .put('/api/voice/policy')
      .send({ networkId: network.id, target: '#dev', minJoinMode: 'halfop' });
    expect(put.status).toBe(200);
    expect(put.body.minJoinMode).toBe('halfop');

    const got = await agent.get(`/api/voice/policy?networkId=${network.id}&target=%23dev`);
    expect(got.body.minJoinMode).toBe('halfop');
  });

  it('rejects unknown modes with 400 instead of coercing them open', async () => {
    // normalizeMinJoinMode falls back to 'none' — coercion here would mean a
    // typo'd restrict request silently UNRESTRICTS the call with a 200.
    enableVoice();
    connectedAs(['o']);
    for (const bad of ['sudo', 'ops', '', 42, null]) {
      const res = await agent
        .put('/api/voice/policy')
        .send({ networkId: network.id, target: '#dev', minJoinMode: bad });
      expect(res.status).toBe(400);
    }
    // The stored policy is untouched by the rejected writes.
    const got = await agent.get(`/api/voice/policy?networkId=${network.id}&target=%23dev`);
    expect(got.body.minJoinMode).toBe('halfop');
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

  function webhookBody(event: string, room: string, numParticipants: number): string {
    return JSON.stringify({
      event,
      room: { name: room, numParticipants },
      participant: { identity: 'bob' },
    });
  }

  it('401 for a missing or forged signature', async () => {
    enableVoice();
    const body = webhookBody('participant_joined', 'net-irc.libera.chat-c-#dev', 1);
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
    h.liveCallCount.mockResolvedValueOnce(3);

    const body = webhookBody('participant_joined', 'net-irc.libera.chat-c-#dev', 1);
    const res = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', await signedAuth(body))
      .send(body);
    expect(res.status).toBe(200);
    await settle();

    // Count is the SFU's answer (3), NOT the event body's numParticipants (1) —
    // the event field is unreliable (see liveCallCount).
    expect(h.liveCallCount).toHaveBeenCalledWith('net-irc.libera.chat-c-#dev');
    expect(fanOutToUser).toHaveBeenCalledTimes(1);
    expect(fanOutToUser).toHaveBeenCalledWith(user.id, {
      kind: 'call-presence',
      networkId: network.id,
      target: '#Dev', // the receiving connection's own wire spelling
      active: true,
      count: 3,
    });
  });

  it('skips the broadcast when the SFU count query fails (stale beats wrongly-cleared)', async () => {
    enableVoice();
    fakeManager.all = [
      makeConn({
        nick: 'alice',
        network: { id: network.id, host: 'irc.libera.chat', user_id: user.id },
        channels: [{ name: '#dev', modes: { alice: [] } }],
      }),
    ];
    h.liveCallCount.mockResolvedValueOnce(null);
    const body = webhookBody('participant_left', 'net-irc.libera.chat-c-#dev', 1);
    const res = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', await signedAuth(body))
      .send(body);
    expect(res.status).toBe(200);
    await settle();
    expect(fanOutToUser).not.toHaveBeenCalled();
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
    const body = webhookBody('participant_joined', 'net-irc.libera.chat-d-alice:bob', 2);
    const res = await testRequest(app)
      .post('/api/voice/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', await signedAuth(body))
      .send(body);
    expect(res.status).toBe(200);
    await settle();
    // A DM room is filtered before the SFU is even asked.
    expect(h.liveCallCount).not.toHaveBeenCalled();
    expect(fanOutToUser).not.toHaveBeenCalled();
  });
});

describe('guest links — /api/voice/guest-link (op-only CRUD)', () => {
  it('403 for non-ops (halfop is not enough to mint)', async () => {
    enableVoice();
    connectedAs(['h']);
    const res = await agent
      .post('/api/voice/guest-link')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(403);
  });

  it('ops mint a link whose URL rides the browser Origin, not the Express host', async () => {
    enableVoice();
    connectedAs(['o']);
    const res = await agent
      .post('/api/voice/guest-link')
      .set('Origin', 'https://irc.example.com')
      .send({ networkId: network.id, target: '#dev' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`https://irc.example.com/call/${res.body.token}`);
    expect(res.body.canPublish).toBe(true);
  });

  it('mints listen-only links and lists active links for ops', async () => {
    enableVoice();
    connectedAs(['q']);
    const mint = await agent
      .post('/api/voice/guest-link')
      .send({ networkId: network.id, target: '#dev', canPublish: false });
    expect(mint.status).toBe(200);
    expect(mint.body.canPublish).toBe(false);

    const list = await agent.get(`/api/voice/guest-link?networkId=${network.id}&target=%23dev`);
    expect(list.status).toBe(200);
    const tokens = (list.body.links as Array<{ token: string }>).map((l) => l.token);
    expect(tokens).toContain(mint.body.token);

    connectedAs(['v']);
    const denied = await agent.get(`/api/voice/guest-link?networkId=${network.id}&target=%23dev`);
    expect(denied.status).toBe(403);
  });

  it('ops revoke; the link stops being usable for NEW joins', async () => {
    enableVoice();
    connectedAs(['o']);
    const mint = await agent
      .post('/api/voice/guest-link')
      .send({ networkId: network.id, target: '#dev' });
    const del = await agent.delete(`/api/voice/guest-link/${mint.body.token}`);
    expect(del.status).toBe(200);

    const res = await testRequest(app)
      .post('/api/voice/guest-token')
      .send({ token: mint.body.token, name: 'late guest' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/voice/guest-token (public)', () => {
  beforeEach(async () => {
    const { resetGuestRateLimit } = await import('./voice.js');
    resetGuestRateLimit();
  });

  async function mintLink(canPublish = true): Promise<string> {
    connectedAs(['o']);
    const mint = await agent
      .post('/api/voice/guest-link')
      .send({ networkId: network.id, target: '#dev', canPublish });
    return mint.body.token as string;
  }

  it('404 for unknown tokens', async () => {
    enableVoice();
    const res = await testRequest(app)
      .post('/api/voice/guest-token')
      .send({ token: 'no-such-link', name: 'x' });
    expect(res.status).toBe(404);
  });

  it('exchanges a live link for a namespaced, room-scoped, SHORT token', async () => {
    enableVoice();
    const link = await mintLink();
    const res = await testRequest(app)
      .post('/api/voice/guest-token')
      .send({ token: link, name: 'Cool Guest!' });
    expect(res.status).toBe(200);
    expect(res.body.canPublish).toBe(true);

    const claims = JSON.parse(
      Buffer.from(String(res.body.token).split('.')[1]!, 'base64url').toString(),
    ) as { sub?: string; exp?: number; nbf?: number; video?: { room?: string } };
    // Identity is namespaced — a guest can never collide with a bare IRC nick.
    expect(claims.sub).toMatch(/^guest-coolguest-[0-9a-f]{8}$/);
    expect(claims.video?.room).toBe('net-irc.libera.chat-c-#dev');
    // 1h TTL, not the members' 2h: a minted token is irrevocable on OSS
    // LiveKit, so its lifetime IS the revocation story for a killed link.
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBeLessThanOrEqual(60 * 60 + 60);
  });

  it('honours the listen-only flag in the LiveKit grant', async () => {
    enableVoice();
    const link = await mintLink(false);
    const res = await testRequest(app)
      .post('/api/voice/guest-token')
      .send({ token: link, name: 'quiet' });
    expect(res.status).toBe(200);
    expect(res.body.canPublish).toBe(false);
    const claims = JSON.parse(
      Buffer.from(String(res.body.token).split('.')[1]!, 'base64url').toString(),
    ) as { video?: { canPublish?: boolean; canSubscribe?: boolean } };
    expect(claims.video?.canPublish).toBe(false);
    expect(claims.video?.canSubscribe).toBe(true);
  });

  it('throttles per IP (429 with Retry-After past the window cap)', async () => {
    // Deterministic: the throttle was reset in beforeEach and allows 10/min —
    // ten mints succeed, the eleventh trips.
    enableVoice();
    const link = await mintLink();
    for (let i = 0; i < 10; i++) {
      const res = await testRequest(app)
        .post('/api/voice/guest-token')
        .send({ token: link, name: `g${i}` });
      expect(res.status).toBe(200);
    }
    const tripped = await testRequest(app)
      .post('/api/voice/guest-token')
      .send({ token: link, name: 'g11' });
    expect(tripped.status).toBe(429);
    expect(Number(tripped.headers['retry-after'])).toBeGreaterThan(0);
  });
});
