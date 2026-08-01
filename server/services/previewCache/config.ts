// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// How the preview byte cache is configured, and the one place that decides
// whether it is on at all.
//
// ⚠ ENV, not instance settings, and that is a deliberate deviation from #681.
// That issue asks for `previews.cache.mode` in `instance_settings` with an admin
// form beside the uploader config, which is the right long-term surface. Every
// other operator-level knob this app has — LURKER_LINK_PREVIEWS,
// LURKER_SECRET_KEY, DATABASE_PATH — is already an env var, so this matches what
// a self-hoster is already doing. `resolveCacheConfig` is the seam the admin
// surface slots into; nothing above this module knows where the values came from.
//
// ⚠ "It would need somewhere to keep a secret" is NOT one of the reasons, and is
// worth naming so nobody adds it: `uploader_config` already stores S3 credentials
// encrypted behind a generic admin form, and `local` has no secret at all. The
// reason is the one above — this knob's neighbours are env vars.

import path from 'path';
import { resolveDataDir } from '../../utils/dataDir.js';

export type CacheMode = 'off' | 'local';

export interface LocalCacheConfig {
  mode: 'local';
  dir: string;
  /** Ceiling for the cache directory. Eviction runs BEFORE a write that would exceed it. */
  maxBytes: number;
}

export type CacheConfig = { mode: 'off' } | LocalCacheConfig;

/** 2 GiB. Big enough that a normal instance never evicts, small enough to notice. */
const DEFAULT_LOCAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * ⚠ Misconfiguration resolves to `off`, and says so once, rather than throwing.
 *
 * This is a cache. A bad value is a reason to stop caching, never a reason for a
 * server not to boot or for a link preview to stop rendering — the uncached path
 * is a complete, working feature, which is what makes failing soft right here and
 * wrong for, say, a database path.
 */
export function resolveCacheConfig(warn: (msg: string) => void = defaultWarn): CacheConfig {
  const mode = env('LURKER_PREVIEW_CACHE_MODE').toLowerCase();
  if (mode === '' || mode === 'off') return { mode: 'off' };

  if (mode === 'local') {
    const raw = env('LURKER_PREVIEW_CACHE_MAX_BYTES');
    // ⚠ Digits only, and a SAFE integer. `parseInt` would take '2GB' and hand back
    // 2 — a two-byte cache that evicts everything it stores and reads as "caching
    // is broken". The upper bound matters for the same reason in the other
    // direction: past MAX_SAFE_INTEGER the eviction arithmetic stops being exact,
    // and a silently wrong answer about whether we are over the ceiling is worse
    // than refusing the value.
    const parsed = /^\d{1,19}$/.test(raw) ? Number(raw) : Number.NaN;
    const usable = Number.isSafeInteger(parsed) && parsed > 0;
    if (raw !== '' && !usable) {
      warn(
        `[preview-cache] LURKER_PREVIEW_CACHE_MAX_BYTES="${raw}" is not a usable byte count — ` +
          `falling back to ${DEFAULT_LOCAL_MAX_BYTES}.`,
      );
    }
    return {
      mode: 'local',
      dir: env('LURKER_PREVIEW_CACHE_DIR') || path.join(resolveDataDir(), 'preview-cache'),
      maxBytes: usable ? parsed : DEFAULT_LOCAL_MAX_BYTES,
    };
  }

  // ⚠ `s3` is deliberately NOT here yet, and this is where somebody will look for
  // it. It was built alongside `local` and split back out, because serving cached
  // bytes from a public CDN is a different feature wearing the same word: it needs
  // a repair path for objects a lifecycle rule has deleted, its own hardening
  // story (headers on a 302 do not apply to the redirect target), and an answer
  // for native clients that forward `Authorization` across redirects. None of that
  // is local's problem, and bundling them let the untested half hide behind the
  // tested one.
  warn(`[preview-cache] unknown LURKER_PREVIEW_CACHE_MODE "${mode}" — caching is OFF.`);
  return { mode: 'off' };
}

function defaultWarn(msg: string): void {
  console.warn(msg);
}
