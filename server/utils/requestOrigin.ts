// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request } from 'express';

function firstHeaderValue(v: unknown): string {
  return String(v ?? '')
    .split(',')[0]
    .trim();
}

const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/;

/**
 * The public origin to build user-facing links against (invite links, guest
 * call links). Layered, most-trustworthy first:
 *
 *  1. The browser-supplied Origin header — the URL the user is actually on
 *     (through Vite's dev proxy that's the :5173 origin; in prod the public
 *     origin regardless of how the reverse proxy forwards to Express).
 *  2. PUBLIC_BASE_URL — the operator's declared public origin. This is what
 *     keeps links right for clients that send no Origin header at all
 *     (native clients, and browsers on same-origin GETs).
 *  3. Validated X-Forwarded-Proto/Host (same spoof guards as the uploads
 *     absolutizer), then the raw Express scheme+host — which behind a proxy is
 *     the internal address, hence the layers above.
 *
 * (Promoted from routes/admin.ts when guest call links needed the same rule.)
 */
export function originFromRequest(req: Request): string {
  const origin = req.get('origin');
  if (origin) return origin;

  const configured = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const rawProto = firstHeaderValue(req.headers['x-forwarded-proto']) || req.protocol;
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
  const rawHost = firstHeaderValue(req.headers['x-forwarded-host']) || req.get('host') || '';
  const host = HOST_RE.test(rawHost) ? rawHost : (req.get('host') ?? '');
  return `${proto}://${host}`;
}
