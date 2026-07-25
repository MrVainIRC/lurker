// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** User account roles. The first registered user is promoted to 'admin'. */
export type UserRole = 'admin' | 'user';

/** A public row from the `users` table (excludes the password_hash column). */
export interface User {
  id: number;
  username: string;
  role: UserRole;
  created_at: string;
  last_seen_at: string | null;
  // 0 | 1. Paused accounts are disconnected from IRC and barred from
  // reconnecting/sending, but retain read-only access to their history.
  is_paused: number;
  // Admin-set identd override (#643), NULL for "derive from the username".
  // Never writable by the account it belongs to — see utils/ident.ts.
  ident: string | null;
}

// One list, so a column added to `User` can't reach one lookup and miss another.
const USER_COLUMNS = 'id, username, role, created_at, last_seen_at, is_paused, ident';

export function findUserByUsername(username: string): User | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username) as
    | User
    | undefined;
}

export function findUserById(id: number | bigint): User | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function listUsers(): User[] {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`).all() as User[];
}

// Throttled to once per minute via the WHERE clause so a busy client (many
// API calls per second) doesn't write to the row on every request — the row
// is only written when the existing value is missing or older than 60s.
export function touchUserLastSeen(userId: number): void {
  db.prepare(
    `
    UPDATE users
       SET last_seen_at = datetime('now')
     WHERE id = ?
       AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-60 seconds'))
  `,
  ).run(userId);
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function countAdmins(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number })
    .n;
}

export function createUser(username: string, { role = 'user' }: { role?: UserRole } = {}): User {
  const info = db.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run(username, role);
  const user = findUserById(info.lastInsertRowid);
  if (!user) throw new Error('createUser: row missing immediately after insert');
  return user;
}

export function getPasswordHash(userId: number): string | null {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string | null }
    | undefined;
  return row ? row.password_hash : null;
}

export function userHasPassword(userId: number): boolean {
  return getPasswordHash(userId) !== null;
}

export function setPasswordHash(userId: number, hash: string | null): boolean {
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  return info.changes > 0;
}

// Flip account access state. Returns false only when no row matched (unknown
// id); an idempotent set to the same value still returns true. The caller owns
// the side effects of a transition — tearing down / re-establishing IRC — since
// this only writes the row.
export function setUserPaused(userId: number, paused: boolean): boolean {
  const info = db
    .prepare('UPDATE users SET is_paused = ? WHERE id = ?')
    .run(paused ? 1 : 0, userId);
  return info.changes > 0;
}

// Set (or clear, with null) the admin-assigned identd override. Takes effect on
// the account's next IRC connect: the ident is answered once, during the ircd's
// registration handshake, so rewriting the live identd map would change nothing
// the servers have already recorded. Returns false only when no row matched.
export function setUserIdent(userId: number, ident: string | null): boolean {
  const info = db.prepare('UPDATE users SET ident = ? WHERE id = ?').run(ident, userId);
  return info.changes > 0;
}

// Hard delete. FKs are ON DELETE CASCADE for sessions / networks / messages /
// settings / etc., so dependent rows vacate on their own.
export function deleteUser(id: number): boolean {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}
