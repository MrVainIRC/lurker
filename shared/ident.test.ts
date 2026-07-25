// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { deriveIdent, isValidIdentOverride } from './ident.js';

describe('deriveIdent', () => {
  it('node edition surfaces the global account id from the acct-<id> username', () => {
    expect(
      deriveIdent({
        nodeMode: true,
        accountUsername: 'acct-42',
      }),
    ).toBe('lu42');
  });

  it('node edition ignores an admin ident override (the control plane owns it)', () => {
    // A cell-local override would break the fleet-wide uniqueness the hosted
    // ident guarantees, so node edition never honours one.
    expect(deriveIdent({ nodeMode: true, accountUsername: 'acct-42', accountIdent: 'alice' })).toBe(
      'lu42',
    );
  });

  it('node edition gives two accounts distinct idents (uniqueness is forced)', () => {
    expect(deriveIdent({ nodeMode: true, accountUsername: 'acct-7' })).toBe('lu7');
    expect(deriveIdent({ nodeMode: true, accountUsername: 'acct-8' })).toBe('lu8');
  });

  it('node edition falls back safely for a non-acct username (e.g. the operator)', () => {
    expect(deriveIdent({ nodeMode: true, accountUsername: 'brad' })).toBe('brad');
  });

  it('standalone uses the lurker account name', () => {
    expect(deriveIdent({ nodeMode: false, accountUsername: 'alice' })).toBe('alice');
  });

  it('standalone prefers an admin-assigned override', () => {
    expect(deriveIdent({ nodeMode: false, accountUsername: 'alice', accountIdent: 'ali' })).toBe(
      'ali',
    );
  });

  it('standalone ignores a blank/whitespace override', () => {
    expect(deriveIdent({ nodeMode: false, accountUsername: 'alice', accountIdent: '  ' })).toBe(
      'alice',
    );
    expect(deriveIdent({ nodeMode: false, accountUsername: 'alice', accountIdent: null })).toBe(
      'alice',
    );
  });

  it('strips ident-invalid characters', () => {
    expect(deriveIdent({ nodeMode: false, accountUsername: 'a b@c!' })).toBe('abc');
  });

  it('strips a leading -, . or _ so the derived path can only emit typeable idents', () => {
    // Usernames may legally start with these (server/utils/username.ts); idents
    // may not, and an admin is blocked from typing one — the two paths have to
    // agree about what an ident is.
    expect(deriveIdent({ nodeMode: false, accountUsername: '-bob' })).toBe('bob');
    expect(deriveIdent({ nodeMode: false, accountUsername: '._x' })).toBe('x');
    expect(isValidIdentOverride(deriveIdent({ nodeMode: false, accountUsername: '-bob' }))).toBe(
      true,
    );
  });

  it('truncates to 16 characters', () => {
    expect(deriveIdent({ nodeMode: false, accountUsername: 'a'.repeat(30) })).toBe('a'.repeat(16));
  });

  it('never returns empty — an unusable name still identifies as "user"', () => {
    expect(deriveIdent({ nodeMode: false, accountUsername: '!!!' })).toBe('user');
    expect(deriveIdent({ nodeMode: false, accountUsername: '' })).toBe('user');
  });
});

// The one property that ties the two halves together: whatever we ANSWER on the
// wire is something an admin could also have typed.
describe('deriveIdent output is always a legal override', () => {
  it('holds for the usernames the account rules allow', () => {
    for (const username of [
      'alice',
      '-bob',
      '.hidden',
      '_x',
      'bob smith',
      'a'.repeat(30),
      '!!!',
      '',
      'Mixed.Case-99',
    ]) {
      expect(
        isValidIdentOverride(deriveIdent({ nodeMode: false, accountUsername: username })),
      ).toBe(true);
    }
  });
});

describe('isValidIdentOverride', () => {
  it('accepts ident-legal values', () => {
    for (const v of ['alice', 'a', 'a.b_c-d', 'x9', 'A'.repeat(16)]) {
      expect(isValidIdentOverride(v)).toBe(true);
    }
  });

  it('rejects values an ircd (or the operator reading it) would choke on', () => {
    // Rejected rather than silently sanitized: quietly reshaping "bob smith"
    // into "bobsmith" would hand the admin an identity they didn't type.
    for (const v of ['', ' ', 'bob smith', 'bob@host', '-bob', '.bob', 'a'.repeat(17), 'héllo']) {
      expect(isValidIdentOverride(v)).toBe(false);
    }
  });
});
