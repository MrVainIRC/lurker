// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The single source of truth for what a valid account username is. Shared by
// the human signup/auth flows (routes/auth.ts) and the orchestrator's node
// provisioning API (routes/node.ts) so an account created by either path is
// valid everywhere it surfaces — the UI, IRC registration, etc. The charset is
// deliberately conservative (no control characters, no exotic Unicode).
//
// Two rules, not one, because CREATING a name and PROVING you own one are
// different jobs:
//
//   isValidUsername      — the rule for a NEW account. Tightened: no spaces, and
//     uniqueness is enforced case-insensitively by the callers (db/users.ts's
//     usernameTaken). A username is an identity people read off a screen and
//     type at a login prompt; "Bob Smith" vs "bob smith" vs "bobsmith" being
//     three separate accounts is a footgun, not a feature. It also feeds the
//     identd ident (shared/ident.ts), which allows neither spaces nor a case
//     distinction — so a space in a username was already being silently dropped
//     somewhere downstream.
//   isValidLoginUsername — the rule for a name being SUBMITTED at login. Accepts
//     anything that could ever have been created, spaces included, because
//     accounts predating the tightening are grandfathered: they keep their name
//     and keep logging in with it. Rejecting them here would lock a real user
//     out of their own instance with no recourse but SQL, which is a far worse
//     outcome than an inelegant legacy username.

export const MAX_USERNAME_LENGTH = 64;

// Tightened rule for new accounts: letters, digits, and . _ - (no spaces).
// The body is exported as a string too, for the signup forms' `pattern`
// attribute — so the browser hint and the server's 400 can't drift apart.
export const USERNAME_PATTERN = '[A-Za-z0-9_.\\-]+';
const USERNAME_CHARS = new RegExp(`^${USERNAME_PATTERN}$`);

// The pre-tightening charset — the same set plus the space. Anything already in
// the DB matches this, so it's exactly what login has to keep accepting.
const LEGACY_USERNAME_CHARS = /^[A-Za-z0-9_.\- ]+$/;

function inBounds(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_USERNAME_LENGTH) return null;
  return trimmed;
}

/** May a NEW account be created with this name? */
export function isValidUsername(name: unknown): boolean {
  const trimmed = inBounds(name);
  return trimmed !== null && USERNAME_CHARS.test(trimmed);
}

/**
 * May this name be submitted at a login prompt? Looser than isValidUsername on
 * purpose — grandfathered accounts must still be able to authenticate. This is
 * only an input-shape guard (the SQL is parameterized either way), so being
 * permissive here costs nothing.
 */
export function isValidLoginUsername(name: unknown): boolean {
  const trimmed = inBounds(name);
  return trimmed !== null && LEGACY_USERNAME_CHARS.test(trimmed);
}

/**
 * Why an existing username wouldn't be creatable today, or null if it's fine.
 * Drives the one-line boot report that names grandfathered accounts, so an
 * operator finds out from a log line instead of from a confused user.
 */
export function nonConformingReason(name: string): string | null {
  if (!isValidUsername(name)) {
    if (/\s/.test(name)) return 'contains a space';
    return 'contains characters no longer allowed';
  }
  return null;
}
