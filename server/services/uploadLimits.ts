// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// THE upload size cap, in one place (#627).
//
// Three ceilings stack, and a client that wants to size media to fit needs the
// smallest of them — not any single one:
//
//   1. MAX_CAP_MB       the registry's own hard ceiling; nothing may exceed it.
//   2. transportCapMb() the request-body limit of whatever sits IN FRONT of this
//                       instance. app.lurker.chat is behind Cloudflare, whose
//                       non-Enterprise limit is 100 MB — a larger body dies at
//                       the edge with a connection reset the client sees as an
//                       unparseable response, before Express is ever reached.
//                       The server cannot detect this, so the operator declares
//                       it via LURKER_MAX_UPLOAD_MB.
//   3. the per-user cap the operator-baked uploader policy (hosted locked row),
//                       else the user's own `uploads.image.max_upload_mb`.
//
// Everything that enforces or advertises a cap goes through here, so multer's
// limit, the handler's 413, and the number we hand clients can never disagree.

import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';
import { resolveUploader } from './uploadProviders/resolve.js';

/** The registry's own ceiling; a per-user cap can't exceed it, so neither can multer. */
export const MAX_CAP_MB = 200;

/** Resolve effective settings with registry defaults filled in. The per-user
 *  image-pipeline settings (size cap, max dimension, JPEG quality) are the
 *  fallback used when the resolved uploader carries no operator-baked policy caps
 *  — i.e. every self-host uploader. Untyped (JS module) → Record<string, unknown>. */
export function effectiveSettings(userId: number): Record<string, unknown> {
  return { ...defaultsAsObject(), ...getUserSettings(userId) };
}

/** The user's size cap. effectiveSettings() has already merged the registry default
 *  in, so this reads it from ONE place — a second hardcoded default here would be a
 *  duplicate that quietly disagrees the next time the registry changes. */
export function userCapMb(settings: Record<string, unknown>): number {
  const n = Number(settings['uploads.image.max_upload_mb']);
  return Number.isFinite(n) && n > 0 ? n : MAX_CAP_MB;
}

/**
 * The instance's transport ceiling: the largest request body that can actually
 * reach this process, as declared by the operator. Unset (the self-hoster with
 * nothing in front of them) → MAX_CAP_MB, i.e. no extra ceiling.
 *
 * Deliberately an env var rather than a tenant setting, for the same reason the
 * node-edition pipeline knobs are: it describes the deployment, not a preference,
 * and a tenant must not be able to raise it. Garbage parses to "unset" rather
 * than 0 — a typo here would otherwise refuse every upload on the instance.
 */
export function transportCapMb(): number {
  const raw = (process.env.LURKER_MAX_UPLOAD_MB || '').trim();
  if (!raw) return MAX_CAP_MB;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return MAX_CAP_MB;
  return Math.min(n, MAX_CAP_MB);
}

/** Clamp a candidate cap to the instance-wide ceilings. Floors at 1 MB so a
 *  hostile or fat-fingered value can never resolve to "refuse everything". */
export function clampUploadCapMb(mb: number): number {
  return Math.max(1, Math.min(mb, transportCapMb(), MAX_CAP_MB));
}

/**
 * The effective cap for this user, in MB — what a client should size media to fit
 * and what the server will actually accept. Resolves the user's DEFAULT uploader:
 * a per-upload `uploaderId` override with a tighter policy cap is caught by the
 * handler's own re-check, which is the number that ends up in the 413.
 *
 * An unusable uploader is not an error here. "How big may I upload" has an answer
 * even when the answer to "where does it go" is currently 400/503 — reporting the
 * user's own clamped cap keeps this from being a second failure surface.
 */
export function effectiveUploadCapMb(userId: number, isAdmin: boolean): number {
  const fallback = userCapMb(effectiveSettings(userId));
  let cap = fallback;
  try {
    cap = resolveUploader({ userId, isAdmin, requestedId: null }).policy.maxMb ?? fallback;
  } catch {
    // No usable uploader configured — fall through to the user's own cap.
  }
  return clampUploadCapMb(cap);
}

/** Same value in bytes, which is the unit clients compare a file size against. */
export function effectiveUploadCapBytes(userId: number, isAdmin: boolean): number {
  return effectiveUploadCapMb(userId, isAdmin) * 1024 * 1024;
}
