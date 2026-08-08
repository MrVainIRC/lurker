// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it } from 'vitest';

import {
  liveKitConfig,
  mintVoiceToken,
  roomFor,
  parseRoom,
  voiceEnabled,
  voiceMasterEnabled,
  meetsJoinMode,
  canModerateCall,
  canAdminCall,
  webhookCallRoom,
  guestIdentity,
  liveCallCount,
  receiveWebhook,
  listActiveCalls,
} from './voice.js';
import type { WebhookEvent } from 'livekit-server-sdk';

// LURKER_VOICE_ENABLED value parsing is the shared parseTruthyEnv — its accepted
// set is pinned by truthyEnv's own tests; only the wiring is exercised here (in
// the 'config gating' describe below).

describe('roomFor', () => {
  it('makes a channel room everyone on the same host+channel derives identically', () => {
    // self is irrelevant for a channel; the host is shared across users and
    // instances, so two different accounts produce the same room.
    expect(roomFor('irc.libera.chat', '#dev', 'alice')).toBe('net-irc.libera.chat-c-#dev');
    expect(roomFor('irc.libera.chat', '#dev', 'bob')).toBe('net-irc.libera.chat-c-#dev');
  });

  it('treats ALL FOUR channel sigils as channels, not DM peers', () => {
    // The most-repeated bug in this codebase is testing only for '#'
    // (see shared/channels.ts). A `&`/`+`/`!` channel misclassified as a DM
    // here would put callers in a nick-pair room instead of the channel room.
    for (const chan of ['#dev', '&local', '+modeless', '!ABCDEchan']) {
      expect(roomFor('irc.libera.chat', chan, 'alice')).toBe(
        `net-irc.libera.chat-c-${chan.toLowerCase()}`,
      );
    }
  });

  it('folds host + channel ASCII-only, leaving sigils and non-ASCII intact', () => {
    expect(roomFor('IRC.Libera.Chat', '#DevOps', 'x')).toBe('net-irc.libera.chat-c-#devops');
    // [] and {} are NOT folded (RFC casemapping deliberately absent, docs §9.2).
    expect(roomFor('irc.libera.chat', '#Foo[Bar]', 'x')).toBe('net-irc.libera.chat-c-#foo[bar]');
  });

  it('gives a DM the SAME room from either end (canonical sorted pair)', () => {
    // The bug this prevents: A's target is "B", B's target is "A" — verbatim
    // naming would split one call into two rooms.
    const fromAlice = roomFor('irc.libera.chat', 'Bob', 'Alice');
    const fromBob = roomFor('irc.libera.chat', 'Alice', 'Bob');
    expect(fromAlice).toBe(fromBob);
    expect(fromAlice).toBe('net-irc.libera.chat-d-alice:bob');
  });

  it("joins the DM pair with ':' so pairs containing '-' can never collide", () => {
    // '-' is legal inside a nick, so a '-' delimiter made ('john-w','ork') and
    // ('john','w-ork') share a room — minting a DM token for the second pair
    // would silently drop the caller into the first pair's private call.
    const a = roomFor('irc.libera.chat', 'ork', 'john-w');
    const b = roomFor('irc.libera.chat', 'w-ork', 'john');
    expect(a).not.toBe(b);
  });

  it('scopes rooms by host, not by per-user network id', () => {
    // Same channel on two different networks → different rooms.
    expect(roomFor('irc.libera.chat', '#dev', 'x')).not.toBe(roomFor('irc.rizon.net', '#dev', 'x'));
  });
});

describe('config gating (env)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('liveKitConfig is null unless all three vars are present', () => {
    delete process.env.LIVEKIT_WS_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    expect(liveKitConfig()).toBeNull();

    process.env.LIVEKIT_WS_URL = 'wss://sfu.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    expect(liveKitConfig()).toBeNull(); // secret still missing

    process.env.LIVEKIT_API_SECRET = 'devsecret';
    expect(liveKitConfig()).toEqual({
      wsUrl: 'wss://sfu.example',
      apiKey: 'devkey',
      apiSecret: 'devsecret',
    });
  });

  it('voiceEnabled requires BOTH the master switch and a full config', () => {
    process.env.LIVEKIT_WS_URL = 'wss://sfu.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret';

    process.env.LURKER_VOICE_ENABLED = 'off';
    expect(voiceMasterEnabled()).toBe(false);
    expect(voiceEnabled()).toBe(false);

    process.env.LURKER_VOICE_ENABLED = 'true';
    expect(voiceEnabled()).toBe(true);

    delete process.env.LIVEKIT_API_SECRET;
    expect(voiceEnabled()).toBe(false); // master on, but config incomplete
  });
});

describe('mintVoiceToken', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function enable() {
    process.env.LIVEKIT_WS_URL = 'wss://sfu.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret-long-enough-for-hs256';
  }

  it('throws when voice is not configured', async () => {
    delete process.env.LIVEKIT_WS_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    await expect(mintVoiceToken({ identity: 'alice', room: 'net-x-c-#dev' })).rejects.toThrow(
      'voice not configured',
    );
  });

  it('mints a JWT scoped to exactly the requested room', async () => {
    enable();
    const minted = await mintVoiceToken({ identity: 'alice', room: 'net-x-c-#dev' });
    expect(minted.room).toBe('net-x-c-#dev');
    expect(minted.url).toBe('wss://sfu.example');

    // Decode the (unencrypted) JWT payload and assert the grant really is
    // room-scoped — this is the security property the whole feature rests on:
    // a token for #dev must not be able to touch #ops.
    const parts = minted.token.split('.');
    expect(parts).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as {
      sub?: string;
      video?: { room?: string; roomJoin?: boolean; canSubscribe?: boolean };
    };
    expect(claims.sub).toBe('alice');
    expect(claims.video?.room).toBe('net-x-c-#dev');
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canSubscribe).toBe(true);
  });
});

describe('meetsJoinMode', () => {
  it("'none' lets anyone in", () => {
    expect(meetsJoinMode([], 'none')).toBe(true);
    expect(meetsJoinMode(['v'], 'none')).toBe(true);
  });
  it('ranks voice < halfop < op; owner/admin count as op', () => {
    expect(meetsJoinMode([], 'voice')).toBe(false);
    expect(meetsJoinMode(['v'], 'voice')).toBe(true);
    expect(meetsJoinMode(['v'], 'op')).toBe(false);
    expect(meetsJoinMode(['h'], 'op')).toBe(false);
    expect(meetsJoinMode(['h'], 'halfop')).toBe(true);
    expect(meetsJoinMode(['o'], 'op')).toBe(true);
    expect(meetsJoinMode(['q'], 'op')).toBe(true);
    expect(meetsJoinMode(['o'], 'halfop')).toBe(true); // op exceeds the halfop bar
  });
});

describe('canModerateCall / canAdminCall', () => {
  it('moderation allows q/a/o/h; admin (join policy) allows q/a/o only', () => {
    expect(canModerateCall(['h'])).toBe(true);
    expect(canModerateCall(['o'])).toBe(true);
    expect(canModerateCall(['v'])).toBe(false);
    expect(canModerateCall([])).toBe(false);
    expect(canAdminCall(['h'])).toBe(false);
    expect(canAdminCall(['o'])).toBe(true);
    expect(canAdminCall(['q'])).toBe(true);
    expect(canAdminCall([])).toBe(false);
  });
});

describe('parseRoom', () => {
  it('is the inverse of roomFor for channel rooms', () => {
    expect(parseRoom('net-irc.libera.chat-c-#dev')).toEqual({
      host: 'irc.libera.chat',
      channel: '#dev',
    });
    // Round-trips a host that contains dashes + a channel with brackets.
    expect(parseRoom(roomFor('my-irc.host.net', '#Foo[Bar]', 'x'))).toEqual({
      host: 'my-irc.host.net',
      channel: '#foo[bar]',
    });
  });

  it('round-trips ALL FOUR channel sigils (the #&+! rule)', () => {
    for (const chan of ['#dev', '&local', '+modeless', '!ABCDEchan']) {
      expect(parseRoom(roomFor('irc.libera.chat', chan, 'x'))).toEqual({
        host: 'irc.libera.chat',
        channel: chan.toLowerCase(),
      });
    }
  });

  it("anchors on the FIRST '-c-<sigil>' so a channel containing '-c-#' still parses", () => {
    // Hostnames can contain '-c-' but never a sigil; channels can contain both.
    expect(parseRoom('net-my-c-host.net-c-#dev')).toEqual({
      host: 'my-c-host.net',
      channel: '#dev',
    });
    expect(parseRoom('net-irc.host-c-#a-c-#b')).toEqual({
      host: 'irc.host',
      channel: '#a-c-#b',
    });
  });

  it('folds ASCII-only so it matches roomFor / foldKey', () => {
    expect(parseRoom('net-IRC.Libera.Chat-c-#DevOps')).toEqual({
      host: 'irc.libera.chat',
      channel: '#devops',
    });
  });

  it('returns null for DM rooms and anything unparseable', () => {
    expect(parseRoom('net-irc.libera.chat-d-alice:bob')).toBeNull();
    expect(parseRoom('not-a-room')).toBeNull();
    expect(parseRoom('net-irc.libera.chat-c-notachannel')).toBeNull();
  });
});

describe('webhookCallRoom', () => {
  const ev = (event: string, room: string): WebhookEvent =>
    ({
      event,
      room: { name: room },
      participant: { identity: 'someone' },
    }) as WebhookEvent;

  it('flags every occupancy-changing event for a channel room', () => {
    // The event is only a TRIGGER — counts come from liveCallCount, because
    // the event's own Room.numParticipants is not reliable (verified against
    // a live SFU: absent on joins, stale on leaves).
    const room = 'net-irc.libera.chat-c-#dev';
    for (const e of [
      'participant_joined',
      'participant_left',
      'participant_connection_aborted',
      'room_finished',
    ]) {
      expect(webhookCallRoom(ev(e, room))).toEqual({
        room,
        host: 'irc.libera.chat',
        channel: '#dev',
      });
    }
  });

  it('ignores DM rooms (no channel to badge) and non-occupancy events', () => {
    expect(webhookCallRoom(ev('participant_joined', 'net-h-d-a:b'))).toBeNull();
    expect(webhookCallRoom(ev('track_published', 'net-irc.libera.chat-c-#x'))).toBeNull();
    expect(webhookCallRoom(ev('room_started', 'net-irc.libera.chat-c-#x'))).toBeNull();
  });
});

describe('receiveWebhook / listActiveCalls / liveCallCount (unconfigured)', () => {
  it('all fail closed when voice is unconfigured', async () => {
    delete process.env.LIVEKIT_WS_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    await expect(receiveWebhook('{}', 'whatever')).resolves.toBeNull();
    await expect(listActiveCalls()).resolves.toEqual([]);
    // null (unknown), NOT 0 — a fabricated zero would clear real badges.
    await expect(liveCallCount('net-h-c-#x')).resolves.toBeNull();
  });
});

describe('guestIdentity', () => {
  it('namespaces + sanitizes so a guest can never be a bare IRC nick', () => {
    expect(guestIdentity('Alice')).toMatch(/^guest-alice-[0-9a-f]{8}$/);
    expect(guestIdentity('bad nick!@#')).toMatch(/^guest-badnick-[0-9a-f]{8}$/);
    expect(guestIdentity('')).toMatch(/^guest-guest-[0-9a-f]{8}$/);
    expect(guestIdentity('x')).not.toBe(guestIdentity('x')); // random suffix
  });
});
