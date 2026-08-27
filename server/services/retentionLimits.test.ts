// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The clamp matrix for effectiveRetentionLines: user setting × operator
// ceiling, with 0 meaning "unlimited" at both layers, and the fail-open
// handling of an unparseable ceiling (a typo must never mass-delete history).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let deleteUserSetting: typeof import('../db/settings.js').deleteUserSetting;
let effectiveRetentionLines: typeof import('./retentionLimits.js').effectiveRetentionLines;
let declaredRetentionCeilingLines: typeof import('./retentionLimits.js').declaredRetentionCeilingLines;

let userId: number;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ setUserSetting, deleteUserSetting } = await import('../db/settings.js'));
  ({ effectiveRetentionLines, declaredRetentionCeilingLines } =
    await import('./retentionLimits.js'));
  userId = createUser('retention-alice').id;
});

afterEach(() => {
  delete process.env.LURKER_MAX_RETENTION_LINES;
  deleteUserSetting(userId, 'data.retention.lines');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('declaredRetentionCeilingLines', () => {
  it('unset means no ceiling', () => {
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('0 is an explicit no-ceiling spelling, not a misconfiguration', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '0';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('a bare integer is the ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '100000';
    expect(declaredRetentionCeilingLines()).toBe(100000);
  });

  it('garbage fails open to no ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '100k';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('a negative value fails open to no ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '-5';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });
});

describe('effectiveRetentionLines', () => {
  it('nothing set anywhere = unlimited (0)', () => {
    expect(effectiveRetentionLines(userId)).toBe(0);
  });

  it('a user setting alone governs', () => {
    setUserSetting(userId, 'data.retention.lines', 5000);
    expect(effectiveRetentionLines(userId)).toBe(5000);
  });

  it('the ceiling alone IS the default for an untouched user', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    expect(effectiveRetentionLines(userId)).toBe(10000);
  });

  it('a user above the ceiling is clamped down to it', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    setUserSetting(userId, 'data.retention.lines', 20000);
    expect(effectiveRetentionLines(userId)).toBe(10000);
  });

  it('a user below the ceiling keeps their own tighter cap', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    setUserSetting(userId, 'data.retention.lines', 5000);
    expect(effectiveRetentionLines(userId)).toBe(5000);
  });

  it('an explicit user 0 (unlimited) still clamps to the ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    setUserSetting(userId, 'data.retention.lines', 0);
    expect(effectiveRetentionLines(userId)).toBe(10000);
  });

  it('an unparseable ceiling leaves the user cap governing', () => {
    process.env.LURKER_MAX_RETENTION_LINES = 'lots';
    setUserSetting(userId, 'data.retention.lines', 5000);
    expect(effectiveRetentionLines(userId)).toBe(5000);
  });
});
