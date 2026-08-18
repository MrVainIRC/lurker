// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// EXPLAIN QUERY PLAN assertions for the id-keyed message paths. The unread
// count being INDEX-ONLY is a load-bearing property (#469: reaching the count
// cap used to mean thousands of scattered rowid lookups per buffer per connect
// snapshot) — these tests pin the plan itself so an index or predicate edit
// that silently de-covers the query fails CI instead of shipping a
// spinning-disk regression.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-eqp-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;

function plan(sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(' | ');
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('unread-count path', () => {
  it('uses the covering per-buffer index (countUnreadRows shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM (
         SELECT 1 FROM messages
         WHERE buffer_id = 1 AND id > 0
           AND type IN ('message','action','notice')
           AND from_ignored = 0
         ORDER BY id DESC
         LIMIT 1000
       )`,
    );
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });
});

describe('page and probe paths', () => {
  it('the backlog page walks the per-buffer index (listMessages shape)', () => {
    const detail = plan(`SELECT * FROM messages WHERE buffer_id = 1 ORDER BY id DESC LIMIT 50`);
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
  });

  it('the edge probe is an index seek (hasOlderThan shape)', () => {
    const detail = plan(`SELECT 1 FROM messages WHERE buffer_id = 1 AND id < 5 LIMIT 1`);
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });
});

describe('highlight-count path', () => {
  it('uses the partial matched index (countHighlightsNewer shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM messages
       WHERE buffer_id = 1 AND id > 0
         AND matched_rule_id IS NOT NULL
         AND from_ignored = 0
         AND notable = 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_matched_buf/);
  });
});

// The searchMessages driving-filter shapes (SEARCH_FILTER_INDEX_PLAN in
// lurker-dev). searchMessages picks which predicate drives each filter-only
// search — these pin the planner's side of that contract. Two of them guard
// regressions that LOOK like simplifications: dropping idx_messages_net
// ("redundant with net_nick's prefix" — it isn't: no id-ordering through the
// nick column, so on:-only degrades to gather-and-sort), and removing the
// unary `+` on the buffer term (the planner then drives from:+in: through the
// buffer index, whose worst case walks a big buffer row-by-row for a nick
// that never spoke there).
describe('search filter paths', () => {
  const ROW_FILTERS = `m.type IN ('message','action','notice')
    AND m.from_ignored = 0 AND m.mirrored = 0`;

  it('from:-only drives the nick index', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id IN (1, 2) AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_net_nick/);
  });

  it('the before cursor rides the nick index range, ordered, no scan', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id = 1 AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE AND m.id < 100
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(
      /USING INDEX idx_messages_net_nick \(network_id=\? AND nick=\? AND id<\?\)/,
    );
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it('from:+in: still drives the nick index (the +buffer demotion)', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id IN (1) AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE AND +m.buffer_id IN (7)
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_net_nick/);
  });

  it('in:+on: drives the buffer index (no network predicate emitted)', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND ${ROW_FILTERS} AND m.buffer_id IN (7)
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
  });

  it('on:-only drives the network index, ordered, no sort', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id = 1 AND ${ROW_FILTERS}
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_net\b/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it('free text keeps FTS driving and streams in rowid order, no sort', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       JOIN messages_fts ON messages_fts.rowid = m.id
       WHERE n.user_id = 1 AND messages_fts MATCH '"hello"' AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE
       ORDER BY messages_fts.rowid DESC LIMIT 51`,
    );
    expect(detail).toMatch(/SCAN messages_fts/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });
});
