// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Voice calls via a self-hosted LiveKit SFU. Lurker never carries media — it is
// only the *token authority*: it already knows who you are and which networks
// you own, so it is the right place to mint a room-scoped LiveKit access token.
// Clients hold only the short-lived token, never the LiveKit API secret — the
// same trust split as session tokens.
//
// Gating mirrors DCC (see dccConfig.ts): OFF by default, opt-in for the
// operator. Voice is "enabled" only when BOTH the master switch is on AND the
// three LiveKit connection vars are present. Anything missing → dark, and
// /api/config advertises voiceEnabled: false so clients hide the call UI
// entirely.
//
// The room-naming rules are pure (no env, no I/O) and unit-tested — they are the
// load-bearing correctness surface. A channel is symmetric (everyone in #dev
// derives the same room), but a DM is not: if A opens a call to B, A's target is
// "B" and B's target is "A". Naming a DM room by (self, target) verbatim would
// put the two ends in two different rooms. So DM rooms are keyed by the
// *canonical* (sorted) nick pair instead.

import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import type { WebhookEvent } from 'livekit-server-sdk';
import { isChannelTarget } from '../../shared/channels.js';
import { parseTruthyEnv } from '../utils/truthyEnv.js';

/** The operator master switch. */
export function voiceMasterEnabled(): boolean {
  return parseTruthyEnv(process.env.LURKER_VOICE_ENABLED);
}

export interface LiveKitConfig {
  /** The wss:// URL the *client* connects to (public origin of the SFU). */
  wsUrl: string;
  apiKey: string;
  apiSecret: string;
}

/** Read the three LiveKit connection vars, or null if any is missing/blank. */
export function liveKitConfig(): LiveKitConfig | null {
  const wsUrl = (process.env.LIVEKIT_WS_URL ?? '').trim();
  const apiKey = (process.env.LIVEKIT_API_KEY ?? '').trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET ?? '').trim();
  if (!wsUrl || !apiKey || !apiSecret) return null;
  return { wsUrl, apiKey, apiSecret };
}

/** Voice is live only when the operator opted in AND the SFU is configured. */
export function voiceEnabled(): boolean {
  return voiceMasterEnabled() && liveKitConfig() !== null;
}

/** ASCII-fold a host to the key used for room names, policy rows, and
 *  presence-fanout comparison. Exported so routes fold identically to
 *  roomFor(). Hostnames are DNS names — plain ASCII case-insensitivity is the
 *  whole rule; channel/nick folding is casemapping territory and happens with
 *  foldTargetFor at the route. */
export function foldKey(s: string): string {
  return foldAscii(s);
}

// ASCII-only lowercasing, to match the client casefold contract (docs
// CLIENT_PROTOCOL §9.2 — RFC 1459 casemapping is deliberately absent; we do not
// fold [] {} etc). Room names must be derivable identically on any instance
// pointed at the same SFU, so this deliberately ignores the per-network
// CASEMAPPING and folds only A–Z.
function foldAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
  }
  return out;
}

/**
 * Derive the LiveKit room name for a call. Pure and deterministic.
 *
 * Keyed on the IRC network's HOST — NOT a local network row id, and NOT the
 * 005 NETWORK token. A networkId is per-account, so two users of the same
 * instance on the same channel would otherwise derive different rooms and
 * never connect. The NETWORK token is *self-declared by the IRC server*: keying
 * on it would let anyone point a Lurker network at a hostile server claiming
 * `NETWORK=Libera`, "join" #dev there, and mint a token for the real Libera
 * channel's room. The host is the one key that is both shared across users and
 * anchored to where the membership check actually ran. The trade-off (accepted,
 * documented in SELF_HOSTING): users must configure the SAME hostname — DNS
 * aliases like irc.libera.chat vs irc.eu.libera.chat derive different rooms.
 *
 *  - Channel `#dev` on irc.libera.chat → `net-irc.libera.chat-c-#dev`
 *  - DM `Alice`↔`bob`                  → `net-irc.libera.chat-d-alice:bob` (sorted, either end)
 *
 * The DM pair is joined with `:` — impossible in an IRC nick (it's the wire
 * framing delimiter), where `-` is legal and made distinct pairs collide:
 * ('john-w','ork') and ('john','w-ork') must NOT share a room, or minting a DM
 * token becomes a way to listen in on someone else's call.
 *
 * `self` is the caller's own nick on the network; it is only consulted for DMs,
 * where it is paired with `target` and sorted so both ends agree on one room.
 * Callers should pass `target`/`self` already folded with the network's
 * declared CASEMAPPING (see routes/voice.ts) so rfc1459 spelling variants of
 * one channel agree on one room; the ASCII fold here is the floor, not the
 * whole rule.
 */
export function roomFor(networkKey: string, target: string, self: string): string {
  const net = foldAscii(networkKey);
  if (isChannelTarget(target)) {
    return `net-${net}-c-${foldAscii(target)}`;
  }
  const a = foldAscii(self);
  const b = foldAscii(target);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `net-${net}-d-${lo}:${hi}`;
}

/**
 * Inverse of roomFor for CHANNEL rooms: recover (host, channel) from a room
 * name, both already folded. Returns null for DM rooms (no channel) or anything
 * unparseable. This lets a webhook resolve presence to a channel even when the
 * in-memory roomChannel map was never seeded for the room — e.g. after a Lurker
 * restart mid-call, or a call started on another instance sharing the SFU.
 *
 * The anchor is the FIRST `-c-` followed by a channel sigil (lazy `.+?`): a
 * hostname can legally contain `-c-` but never a sigil character, while a
 * channel name may itself contain `-c-#…` — so the first sigil-anchored hit is
 * always the true host/channel boundary. All four sigils (#&+!), per
 * shared/channels.ts — anchoring on `[#&]` alone would silently drop the
 * restart-survival fallback for `+`/`!` channels.
 */
export function parseRoom(room: string): { host: string; channel: string } | null {
  const m = /^net-(.+?)-c-([#&+!].*)$/.exec(room);
  if (!m) return null;
  return { host: foldAscii(m[1]!), channel: foldAscii(m[2]!) };
}

export interface MintedToken {
  /** The signed JWT the client passes to LiveKit. */
  token: string;
  /** The room it is scoped to. */
  room: string;
  /** The wss:// URL to connect to. */
  url: string;
}

/**
 * Mint a room-scoped LiveKit access token. Grants join + publish + subscribe on
 * exactly one room and nothing else — a token for `#dev` cannot touch `#ops`.
 * Identity is the caller's IRC nick so remote participants render sensible names.
 * Throws if voice is not configured (callers should have gated on voiceEnabled).
 */
export async function mintVoiceToken(args: {
  identity: string;
  room: string;
}): Promise<MintedToken> {
  const cfg = liveKitConfig();
  if (!cfg) throw new Error('voice not configured');

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: args.identity,
    ttl: 2 * 60 * 60, // 2h — a call comfortably outlives its join token
  });
  at.addGrant({
    roomJoin: true,
    room: args.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  return { token, room: args.room, url: cfg.wsUrl };
}

// ─── Channel-mode authority ────────────────────────────────────────────────
// One definition, shared with the client (the UI mirrors these gates to decide
// which controls to render) — see shared/voiceModes.ts. Re-exported so server
// callers keep importing from the voice service.

export { meetsJoinMode, canModerateCall, canAdminCall } from '../../shared/voiceModes.js';

// ─── Server-side room control (moderation) ─────────────────────────────────
// A fresh RoomServiceClient per call — construction is cheap and a config
// change (secret rotation) is always picked up. API host is the wss URL mapped
// to http(s). These act with roomAdmin, which the SDK signs from the same api
// key/secret — clients never receive an admin-capable token.

function roomService(): RoomServiceClient | null {
  const cfg = liveKitConfig();
  if (!cfg) return null;
  return new RoomServiceClient(cfg.wsUrl.replace(/^ws/, 'http'), cfg.apiKey, cfg.apiSecret);
}

/** Force-remove a participant (by identity) from a room. NOTE: on self-hosted
 *  (OSS) LiveKit this does NOT invalidate their still-valid join token —
 *  immediate token revocation on removal is a LiveKit Cloud feature. Well-
 *  behaved client SDKs won't auto-rejoin after a removal, but a raw client can
 *  reconnect until the token's 2h TTL runs out. Docs carry the honest caveat. */
export async function removeFromCall(room: string, identity: string): Promise<void> {
  const svc = roomService();
  if (!svc) throw new Error('voice not configured');
  await svc.removeParticipant(room, identity);
}

/** Server-mute all of a participant's published tracks. NOTE: on self-hosted
 *  (OSS) LiveKit a server mute is not locked — the participant can unmute
 *  themselves (mute-locking, like token revocation, is a Cloud feature). Their
 *  client shows "an operator muted you", so it reads as a strong nudge; the
 *  enforcement tool is remove. No-op if they are not currently in the room. */
export async function muteParticipant(room: string, identity: string): Promise<void> {
  const svc = roomService();
  if (!svc) throw new Error('voice not configured');
  const parts = await svc.listParticipants(room);
  const p = parts.find((x) => x.identity === identity);
  if (!p) return;
  for (const t of p.tracks ?? []) {
    await svc.mutePublishedTrack(room, identity, t.sid, true);
  }
}

/** Snapshot every active CHANNEL call the SFU currently knows about, so a
 *  freshly-connected client can hydrate presence badges for calls that started
 *  before it connected — the webhook stream only carries live deltas. LiveKit
 *  is the source of truth, so this is correct across a Lurker restart (unlike
 *  the in-memory registry). Returns [] when voice is unconfigured. */
export async function listActiveCalls(): Promise<
  Array<{ host: string; channel: string; count: number }>
> {
  const svc = roomService();
  if (!svc) return [];
  const rooms = await svc.listRooms();
  const out: Array<{ host: string; channel: string; count: number }> = [];
  for (const r of rooms) {
    const parsed = parseRoom(r.name);
    if (!parsed) continue; // DM rooms + anything unparseable carry no channel badge
    out.push({
      host: parsed.host,
      channel: parsed.channel,
      count: r.numParticipants ?? 0,
    });
  }
  return out;
}

// ─── Call presence (webhooks trigger, the SFU API answers) ─────────────────
// Two designs died before this one. A delta registry lies after a restart (the
// first post-restart join "resets" a 3-person badge to 1). The event's own
// Room.numParticipants looked authoritative but is not, verified against a live
// SFU: it is ABSENT (=0) on participant_joined, and on participant_left it
// still included the leaver AND a participant whose unclean disconnect hadn't
// registered yet. So a webhook is only a TRIGGER that occupancy changed; the
// count is fetched from the SFU's participant list — the same source /presence
// hydration uses, which QA showed is right. One API round-trip per join/leave
// is nothing at call-event rates.

export interface CallPresenceChange {
  room: string;
  host: string;
  channel: string;
  active: boolean;
  count: number;
}

/** Verify + parse a LiveKit webhook body. Null if the signature is invalid or
 *  voice is unconfigured. */
export async function receiveWebhook(
  body: string,
  authHeader: string | undefined,
): Promise<WebhookEvent | null> {
  const cfg = liveKitConfig();
  if (!cfg) return null;
  try {
    return await new WebhookReceiver(cfg.apiKey, cfg.apiSecret).receive(body, authHeader);
  } catch {
    return null;
  }
}

/** Pure half: does this verified webhook event mean a CHANNEL room's occupancy
 *  may have changed, and for which (host, channel)? Null for non-occupancy
 *  events and for DM rooms (DM presence is never broadcast — that would leak
 *  who is talking to whom). */
export function webhookCallRoom(
  ev: WebhookEvent,
): { room: string; host: string; channel: string } | null {
  const room = ev.room?.name;
  if (!room) return null;
  switch (ev.event) {
    case 'participant_joined':
    case 'participant_left':
    case 'participant_connection_aborted':
    case 'room_finished':
      break;
    default:
      return null;
  }
  const mapping = parseRoom(room); // the room name encodes (host, channel)
  if (!mapping) return null;
  return { room, host: mapping.host, channel: mapping.channel };
}

/** The room's live participant count straight from the SFU, or null when it
 *  can't be determined (unconfigured / API failure) — callers must SKIP the
 *  broadcast then, because a made-up 0 would wrongly clear every badge on a
 *  transient error. A room the SFU no longer knows counts as genuinely 0. */
export async function liveCallCount(room: string): Promise<number | null> {
  const svc = roomService();
  if (!svc) return null;
  try {
    return (await svc.listParticipants(room)).length;
  } catch (err) {
    // listParticipants rejects for a closed/unknown room — that IS zero. Only
    // treat it as unknown if the SFU itself was unreachable.
    const msg = String((err as Error)?.message ?? err);
    if (/not found|does not exist|404/i.test(msg)) return 0;
    console.error('[voice] live count query failed:', err);
    return null;
  }
}
