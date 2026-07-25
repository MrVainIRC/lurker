// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

setupTestDb('services-upload-limits');

let user: User;
let admin: User;
let setUserSetting: (userId: number, key: string, value: unknown) => void;
let limits: typeof import('./uploadLimits.js');

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ setUserSetting } = await import('../db/settings.js'));
  limits = await import('./uploadLimits.js');
  user = createUser('alice');
  admin = createUser('root');
});

afterEach(() => {
  delete process.env.LURKER_MAX_UPLOAD_MB;
});

describe('transportCapMb', () => {
  it('is the hard ceiling when unset — a self-hoster with nothing in front of them', () => {
    expect(limits.transportCapMb()).toBe(limits.MAX_CAP_MB);
  });

  it('honors the operator-declared proxy/CDN limit', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.transportCapMb()).toBe(100);
  });

  it('can never RAISE the hard ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '5000';
    expect(limits.transportCapMb()).toBe(limits.MAX_CAP_MB);
  });

  it('treats garbage and non-positive values as unset, never as "refuse everything"', () => {
    // A typo here would otherwise take every upload on the instance down, which
    // is a much worse failure than ignoring the value.
    for (const raw of ['', '  ', 'lots', '0', '-10', 'NaN']) {
      process.env.LURKER_MAX_UPLOAD_MB = raw;
      expect(limits.transportCapMb()).toBe(limits.MAX_CAP_MB);
    }
  });

  it('floors a fractional value rather than rounding up past the proxy limit', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '99.9';
    expect(limits.transportCapMb()).toBe(99);
  });
});

describe('effectiveUploadCapMb', () => {
  it("defaults to the user's own setting", () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 150);
    expect(limits.effectiveUploadCapMb(user.id, false)).toBe(150);
  });

  it('is the SMALLEST of the ceilings — the transport limit wins when it is lower', () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 150);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.effectiveUploadCapMb(user.id, false)).toBe(100);
  });

  it("does not inflate a user's lower cap up to the transport limit", () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.effectiveUploadCapMb(user.id, false)).toBe(25);
  });

  it('answers for a user with no settings row at all (registry default applies)', () => {
    // "How big may I upload" must have an answer before the user has touched a
    // single setting — this is the value a fresh client is told on connect.
    expect(limits.effectiveUploadCapMb(admin.id, true)).toBeGreaterThan(0);
    expect(limits.effectiveUploadCapMb(admin.id, true)).toBeLessThanOrEqual(limits.MAX_CAP_MB);
  });

  it('reports bytes as MB × 1024²', () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 42);
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(42 * 1024 * 1024);
  });
});

describe('clampUploadCapMb', () => {
  it('floors at 1 MB so no configuration can resolve to "refuse everything"', () => {
    expect(limits.clampUploadCapMb(0)).toBe(1);
    expect(limits.clampUploadCapMb(-5)).toBe(1);
  });

  it('applies the transport ceiling to a policy cap the operator baked higher', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.clampUploadCapMb(200)).toBe(100);
  });
});
