// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterEach } from 'vitest';
import { resolveCacheConfig } from './config.js';

const KEYS = [
  'LURKER_PREVIEW_CACHE_MODE',
  'LURKER_PREVIEW_CACHE_DIR',
  'LURKER_PREVIEW_CACHE_MAX_BYTES',
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('resolveCacheConfig', () => {
  it('is off when nothing is set, which is the shipped default', () => {
    expect(resolveCacheConfig().mode).toBe('off');
    process.env.LURKER_PREVIEW_CACHE_MODE = 'off';
    expect(resolveCacheConfig().mode).toBe('off');
  });

  it('rejects an unknown mode rather than guessing at it, and says so', () => {
    // ⚠⚠ `s3` lands here on purpose while it is split out. An operator who sets it
    // gets a warning and a working uncached instance — never a half-configured
    // cache that quietly behaves like something else.
    for (const mode of ['r2', 's3', 'bucket']) {
      process.env.LURKER_PREVIEW_CACHE_MODE = mode;
      const warnings: string[] = [];
      expect(`${mode} → ${resolveCacheConfig((m) => warnings.push(m)).mode}`).toBe(`${mode} → off`);
      expect(warnings.join(' ')).toMatch(/caching is OFF/);
    }
  });

  it('defaults the local directory and ceiling', () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
    const cfg = resolveCacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    expect(cfg.dir).toMatch(/preview-cache$/);
    expect(cfg.maxBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it('takes a plain byte count, and refuses anything that is not one', () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
    const DEFAULT = 2 * 1024 * 1024 * 1024;

    process.env.LURKER_PREVIEW_CACHE_MAX_BYTES = '1048576';
    const set = resolveCacheConfig();
    if (set.mode !== 'local') throw new Error('unreachable');
    expect(set.maxBytes).toBe(1048576);

    // ⚠ `parseInt` would take '2GB' and hand back 2 — a two-byte cache that evicts
    // everything it stores and reads as "caching is broken". A number past
    // MAX_SAFE_INTEGER is refused for the mirror-image reason: the eviction
    // arithmetic stops being exact, and a silently wrong answer about whether we
    // are over the ceiling is worse than no answer.
    for (const bad of ['2GB', '-1', '0', 'lots', '1.5', '1e9', '99999999999999999999']) {
      process.env.LURKER_PREVIEW_CACHE_MAX_BYTES = bad;
      const warnings: string[] = [];
      const cfg = resolveCacheConfig((m) => warnings.push(m));
      if (cfg.mode !== 'local') throw new Error('unreachable');
      expect(`${bad} → ${cfg.maxBytes}`).toBe(`${bad} → ${DEFAULT}`);
      // ...and never silently, or an operator debugs a cache that looks like it is
      // ignoring the setting they just wrote.
      expect(`${bad}: ${warnings.length > 0 ? 'warned' : 'silent'}`).toBe(`${bad}: warned`);
    }
  });

  it('honours an explicit cache directory', () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
    process.env.LURKER_PREVIEW_CACHE_DIR = '/tmp/somewhere-else';
    const cfg = resolveCacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    expect(cfg.dir).toBe('/tmp/somewhere-else');
  });
});
