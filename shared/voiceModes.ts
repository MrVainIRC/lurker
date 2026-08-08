// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The single definition of voice-call mode authority, shared by both tiers —
// the server enforces it (services/voice.ts, routes/voice.ts) and the client
// mirrors it to decide which controls to render (CallBar, MemberList). Split
// across tiers this had already been copied three times; a rank change made in
// one place would desynchronize what the UI shows from what the server allows.
//
// IRC prefix modes, ranked. Owner (q), admin (a) and op (o) all count as the
// top "op" tier; halfop (h) above voice (v). Read from a member's mode letters.
//
// (useMemberActions has its own op/halfop sets for the IRC action menus — that
// is deliberate: kick/ban authority is the IRC server's call, not ours, and
// its UX gates predate voice. Only VOICE-call authority lives here.)

/** The lowest prefix mode allowed to join a channel's call. */
export type MinJoinMode = 'none' | 'voice' | 'halfop' | 'op';

const VALID_MODES: ReadonlySet<string> = new Set(['none', 'voice', 'halfop', 'op']);

/** Strict validation — for WRITE boundaries. A security control must reject
 *  unknown input, never coerce it (a coerced typo silently UNRESTRICTS the
 *  call, because the fallback is 'none'). */
export function isMinJoinMode(raw: unknown): raw is MinJoinMode {
  return typeof raw === 'string' && VALID_MODES.has(raw);
}

/** Lenient normalization — for READS. A stored value from a future/older
 *  version fails open to 'none' instead of throwing. */
export function normalizeMinJoinMode(raw: unknown): MinJoinMode {
  return isMinJoinMode(raw) ? raw : 'none';
}

const MODE_RANK: Record<MinJoinMode, number> = {
  none: 0,
  voice: 1,
  halfop: 2,
  op: 3,
};
const LETTER_RANK: Record<string, number> = { v: 1, h: 2, o: 3, a: 3, q: 3 };
const MODERATE_LETTERS = new Set(['q', 'a', 'o', 'h']); // may mute/remove in a call
const OP_LETTERS = new Set(['q', 'a', 'o']); // may set the join policy

/** Does a member holding these prefix modes meet a channel's min join mode? */
export function meetsJoinMode(modes: readonly string[], min: MinJoinMode): boolean {
  const need = MODE_RANK[min] ?? 0;
  if (need === 0) return true;
  let have = 0;
  for (const m of modes) have = Math.max(have, LETTER_RANK[m] ?? 0);
  return have >= need;
}

/** Ops/halfops — allowed to mute or remove others from a call. */
export function canModerateCall(modes: readonly string[]): boolean {
  return modes.some((m) => MODERATE_LETTERS.has(m));
}

/** Ops (q/a/o) — allowed to set the join policy. */
export function canAdminCall(modes: readonly string[]): boolean {
  return modes.some((m) => OP_LETTERS.has(m));
}

// ─── Guest identities ───────────────────────────────────────────────────────
// Guests joining via a capability link get namespaced LiveKit identities so
// they can never collide with or impersonate a bare IRC nick. The server mints
// them (see guestIdentity in server/services/voice.ts — shape pinned by its
// tests); clients use these to RENDER guests differently instead of showing
// the raw machine identity ('guest-coolguest-3fa9b2c1').

const GUEST_IDENTITY_RE = /^guest-([a-z0-9_-]*)-[0-9a-f]{8}$/;

/** True for a minted guest identity; a bare-nick identity is never a guest. */
export function isGuestIdentity(identity: string): boolean {
  return GUEST_IDENTITY_RE.test(identity);
}

/** The human name inside a guest identity ('guest-coolguest-3fa9b2c1' →
 *  'coolguest'), or the identity unchanged when it isn't a guest. */
export function guestDisplayName(identity: string): string {
  const m = GUEST_IDENTITY_RE.exec(identity);
  return m ? m[1] || 'guest' : identity;
}
