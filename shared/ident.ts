// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Derives the IRC ident (the user part of nick!ident@host) that the built-in
// identd reports for a connection.
//
// The ident is an ATTRIBUTION handle, not a preference. On a multi-user instance
// every member shares one IP, so `nick!ident@shared.host` is the only thing a
// network operator can use to tell them apart — to ban one member without
// banning everyone, or to tell the instance's admin WHO did something. That only
// works if the ident is assigned rather than chosen: a self-service ident lets
// one member wear another member's ident, or churn it to slip a ban, which
// defeats the point of running an identd at all (#643). So it comes from the
// LURKER ACCOUNT, never from the per-network username or nick the user types.
//
//   node edition — the ident must identify the GLOBAL account, so it's stable
//     across cell moves and unique fleet-wide. Cells are provisioned with the
//     account username `acct-<controlPlaneAccountId>`, so we surface
//     `lu<controlPlaneAccountId>` ("lu" = Lurker user, so a network operator can
//     tell at a glance it's one of ours). Using the cell-local user id would
//     change if an account were ever migrated to another cell. The per-user
//     override is IGNORED here — the control plane owns hosted identity, and a
//     cell-side override would break fleet-wide uniqueness.
//   standalone — the Lurker account username, unless an admin has set an
//     explicit override for that account (users.ident, admin panel → users).
//     Admin-only by design: it's the operator's call who is called what.
//
// UNIQUENESS IS NOT GUARANTEED on the standalone derived path, and deliberately
// isn't faked. Usernames are unique but far looser than idents (spaces allowed,
// case-sensitive, up to 64 chars — server/utils/username.ts), so "bob smith" and
// "bobsmith" both derive `bobsmith`, as do "Bob"/"bob" and any two usernames
// sharing their first 16 characters. Resolving that HERE would mean mixing in
// something like the row id when a clash appears, which makes an account's ident
// change when an unrelated account signs up — and an ident that moves is worse
// than one that's ambiguous, because bans and ACLs are keyed on it. So the
// derivation stays stable and pure, the admin API refuses to CREATE a collision,
// and the admin panel flags any that exist for the operator to settle with an
// override (routes/admin.ts).

/** Max ident length. Longer values are truncated by most ircds anyway. */
export const MAX_IDENT_LENGTH = 16;

const NON_IDENT_CHARS = /[^A-Za-z0-9._-]/g;
// Usernames may legally start with '-', '.' or '_' (see server/utils/username.ts),
// so the derived path has to trim them too — a leading '-' reads as a flag to
// downstream tooling and some ircds reject it. Without this, an account named
// '-bob' would be ANSWERED an ident that isValidIdentOverride refuses to let an
// admin type, and the two paths would disagree about what an ident is.
const LEADING_NON_ALNUM = /^[._-]+/;

export function sanitizeIdent(value: string): string {
  return value
    .replace(NON_IDENT_CHARS, '')
    .replace(LEADING_NON_ALNUM, '')
    .slice(0, MAX_IDENT_LENGTH);
}

// What an admin may type as a per-user override. Stricter than sanitizeIdent
// (which silently drops whatever it can't use): the admin should be told their
// value is unusable rather than have it quietly reshaped into a different
// identity. Must start alphanumeric — a leading '-' reads as a flag to
// downstream tooling and some ircds reject it outright.
//
// Invariant worth keeping: every deriveIdent() result also satisfies this, so
// an ident nobody could type is never one we answer.
export function isValidIdentOverride(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_IDENT_LENGTH - 1}}$`).test(value);
}

export function deriveIdent(opts: {
  nodeMode: boolean;
  accountUsername: string;
  /** Admin-set per-account override (users.ident). Standalone only. */
  accountIdent?: string | null;
}): string {
  if (opts.nodeMode) {
    const m = /^acct-(\d+)$/.exec(opts.accountUsername.trim());
    if (m) return sanitizeIdent(`lu${m[1]}`);
    // Fallback (e.g. the operator's own admin account on a cell): stay stable +
    // ident-safe rather than inventing an id.
    return sanitizeIdent(opts.accountUsername) || 'user';
  }
  return (
    sanitizeIdent((opts.accountIdent || '').trim()) || sanitizeIdent(opts.accountUsername) || 'user'
  );
}
