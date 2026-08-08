// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request } from 'express';

/**
 * The public origin to build user-facing links against (invite links, guest
 * call links). Prefer the browser-supplied Origin header so the link reflects
 * the URL the user is actually on — through Vite's dev proxy that's the :5173
 * origin, and in prod it's the public origin regardless of how the reverse
 * proxy forwards to Express. req.protocol/req.get('host') would otherwise leak
 * the upstream Express scheme + host (http://localhost:8010). Falls back to
 * scheme://host for the rare request without an Origin header.
 *
 * (Promoted from routes/admin.ts when guest call links needed the same rule.)
 */
export function originFromRequest(req: Request): string {
  const origin = req.get('origin');
  if (origin) return origin;
  return `${req.protocol}://${req.get('host')}`;
}
