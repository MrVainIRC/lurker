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

/** Max ident length. Longer values are truncated by most ircds anyway. */
export const MAX_IDENT_LENGTH = 16;

const NON_IDENT_CHARS = /[^A-Za-z0-9._-]/g;

export function sanitizeIdent(value: string): string {
  return value.replace(NON_IDENT_CHARS, '').slice(0, MAX_IDENT_LENGTH);
}

// What an admin may type as a per-user override. Stricter than sanitizeIdent
// (which silently drops whatever it can't use): the admin should be told their
// value is unusable rather than have it quietly reshaped into a different
// identity. Must start alphanumeric — a leading '-' reads as a flag to
// downstream tooling and some ircds reject it outright.
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
