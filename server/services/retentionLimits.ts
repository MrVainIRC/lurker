// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// THE per-buffer history cap, in one place (lurker-dev/RETENTION_PLAN.md).
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
import * as systemLog from './systemLog.js';

// Warn once per process PER VAR, not per sweep tick: a misconfiguration that
// repeats every minute is noise rather than a signal.
const warnedBadCeiling = new Set<string>();

/**
 * Parse one ceiling env var: a bare decimal integer, `0` accepted as an
 * explicit "no ceiling" spelling. Strictness is the point — Number()
 * coercions like "1.9" → 1 or "1e5" → 100000 would silently enable pruning
 * with a ceiling the operator never wrote.
 *
 * Anything unparseable falls back to NO ceiling, loudly. Fail-open is the
 * only safe direction for these knobs: a typo that resolved to some small
 * number would quietly mass-delete history that cannot be restored.
 */
function parseCeilingEnv(name: string, unit: string, example: string): number | null {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(value)) {
    if (!warnedBadCeiling.has(name)) {
      warnedBadCeiling.add(name);
      const text =
        `${name}="${raw}" is not a whole number of ${unit}; ignoring it. ` +
        `History is NOT bounded by this ceiling. Use a bare integer, e.g. ${example}.`;
      console.warn(`[lurker] ${text}`);
      // Also into the system buffer: "the ceiling never took effect" is an
      // operator-facing condition, and stdout is not an operator surface.
      systemLog.log({ level: 'warn', scope: 'server', text });
    }
    return null;
  }
  return value === 0 ? null : value;
}

/** The operator's per-buffer line ceiling, or null when none is declared. */
export function declaredRetentionCeilingLines(): number | null {
  return parseCeilingEnv(
    'LURKER_MAX_RETENTION_LINES',
    'lines',
    'LURKER_MAX_RETENTION_LINES=100000',
  );
}

/** The operator's noise-age ceiling in hours, or null when none is declared. */
export function declaredEventRetentionCeilingHours(): number | null {
  return parseCeilingEnv(
    'LURKER_MAX_EVENT_RETENTION_HOURS',
    'hours',
    'LURKER_MAX_EVENT_RETENTION_HOURS=336',
  );
}

/**
 * The effective per-buffer cap for this user, in lines — the number the
 * sweeper actually prunes to. 0 = unlimited. The user's stored value is read
 * with the registry default merged in (the uploadLimits pattern), so a second
 * hardcoded default here can't drift from the registry.
 */
export function effectiveRetentionLines(userId: number): number {
  const settings = { ...defaultsAsObject(), ...getUserSettings(userId) };
  return clampToCeiling(settings['data.retention.lines'], declaredRetentionCeilingLines());
}

/**
 * The effective noise-clock age for this user, in hours — rows in
 * EARLY_PRUNE_TYPES older than this are pruned regardless of the line cap.
 * 0 = the noise clock is off (events live as long as chat). Same
 * min-of-the-nonzero stacking as the line cap; the registry default (168) is
 * what an untouched user gets.
 */
export function effectiveEventRetentionHours(userId: number): number {
  const settings = { ...defaultsAsObject(), ...getUserSettings(userId) };
  return clampToCeiling(
    settings['data.retention.event_hours'],
    declaredEventRetentionCeilingHours(),
  );
}

function clampToCeiling(rawSetting: unknown, ceiling: number | null): number {
  const n = Number(rawSetting);
  const userValue = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (ceiling == null) return userValue;
  return userValue === 0 ? ceiling : Math.min(userValue, ceiling);
}
