// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// THE per-buffer history cap, in one place (RETENTION_PLAN.md).
//
// Two values stack, and the effective cap is the smaller of the ones actually
// set:
//
//   1. the operator ceiling  LURKER_MAX_RETENTION_LINES. An env var rather
//                            than a tenant setting for the same reason
//                            LURKER_MAX_UPLOAD_MB is: it describes the
//                            deployment, and a tenant must not be able to
//                            raise it. There is deliberately no separate
//                            operator *default* — an untouched user setting
//                            resolves to unlimited and then clamps to the
//                            ceiling, so the ceiling IS the default.
//   2. the user's own        `data.retention.lines` (0 = unlimited).
//
// 0 (or unset) means "keep everything" at every layer. Every path that
// enforces or advertises a retention cap goes through effectiveRetentionLines
// so the sweeper and whatever a client is told can never disagree.

import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';

// Warn once per process, not per sweep tick: a misconfiguration that repeats
// every minute is noise rather than a signal.
let warnedBadCeiling = false;

/**
 * What the operator DECLARED, in lines per buffer, or null when they declared
 * no ceiling. `0` is accepted as an explicit "no ceiling" spelling and is not
 * a misconfiguration.
 *
 * Anything unparseable falls back to NO ceiling, loudly. Fail-open is the only
 * safe direction for this particular knob: a typo that resolved to some small
 * number would quietly mass-delete history that cannot be restored.
 */
export function declaredRetentionCeilingLines(): number | null {
  const raw = (process.env.LURKER_MAX_RETENTION_LINES || '').trim();
  if (!raw) return null;
  const lines = Math.floor(Number(raw));
  if (!Number.isFinite(lines) || lines < 0) {
    if (!warnedBadCeiling) {
      warnedBadCeiling = true;
      console.warn(
        `[lurker] LURKER_MAX_RETENTION_LINES="${raw}" is not a whole number of ` +
          'lines; ignoring it. History is NOT bounded by an instance ceiling. ' +
          'Use a bare integer, e.g. LURKER_MAX_RETENTION_LINES=100000.',
      );
    }
    return null;
  }
  return lines === 0 ? null : lines;
}

/**
 * The effective per-buffer cap for this user, in lines — the number the
 * sweeper actually prunes to. 0 = unlimited. The user's stored value is read
 * with the registry default merged in (the uploadLimits pattern), so a second
 * hardcoded default here can't drift from the registry.
 */
export function effectiveRetentionLines(userId: number): number {
  const settings = { ...defaultsAsObject(), ...getUserSettings(userId) };
  const n = Number(settings['data.retention.lines']);
  const userCap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const ceiling = declaredRetentionCeilingLines();
  if (ceiling == null) return userCap;
  return userCap === 0 ? ceiling : Math.min(userCap, ceiling);
}
