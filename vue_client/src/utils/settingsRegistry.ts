// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client-side wrapper around the shared settings registry. Re-exports the
// data + shared helpers and adds getDefault(), the lookup pattern the
// Settings UI uses to seed inputs before the user-saved values arrive.

import {
  REGISTRY,
  getOption,
  defaultsAsObject,
  CATEGORIES,
  GROUPS,
} from '../../../shared/settingsRegistry.js';
import type {
  SettingValue,
  SettingOption,
  SettingCategory,
} from '../../../shared/settingsRegistry.js';

export { REGISTRY, getOption, defaultsAsObject, CATEGORIES, GROUPS };

export function getDefault(key: string): SettingValue | undefined {
  const opt = getOption(key);
  return opt ? opt.default : undefined;
}

/** Edition context that decides which settings surfaces are visible. */
export interface VisibilityContext {
  isNode: boolean;
}

/**
 * Whether a settings category shows in the sidebar. `selfHostedOnly` categories
 * are hidden in the hosted (node) edition, where the operator — not the tenant —
 * owns them.
 *
 * There is deliberately no admin dimension here any more: instance administration
 * lives entirely in the /admin panel, so Settings holds nothing an admin sees and
 * a regular user doesn't.
 */
export function categoryVisible(cat: SettingCategory, ctx: VisibilityContext): boolean {
  if (cat.selfHostedOnly && ctx.isNode) return false;
  return true;
}

/** Whether an individual registry setting renders, given the edition. */
export function optionVisible(opt: SettingOption, ctx: Pick<VisibilityContext, 'isNode'>): boolean {
  if (opt.selfHostedOnly && ctx.isNode) return false;
  return true;
}

// How deep a dependsOn chain we follow before giving up. Real chains are two
// links (`consolidate_max_names → consolidate_joins → chat.events`); the cap is
// purely so a registry edit that accidentally makes a cycle greys a row out
// instead of hanging the settings pane.
const MAX_DEPENDENCY_DEPTH = 8;

/**
 * Whether a setting currently DOES anything, per its `dependsOn` clauses.
 *
 * Clauses are ORed: the option is live if any one of them holds. Resolution is
 * transitive — an option whose dependency is itself inactive is inactive too —
 * so the registry states each link once instead of restating the whole chain on
 * every leaf.
 *
 * Inactive is a rendering state, never a storage one: the value is kept and
 * still returned, because flipping the condition back has to restore what the
 * user had rather than a pile of defaults.
 *
 * `read` supplies effective values (i.e. `settingsStore.effective`).
 */
export function optionEnabled(
  opt: SettingOption,
  read: (key: string) => SettingValue | undefined,
  depth = 0,
): boolean {
  if (!opt.dependsOn?.length) return true;
  if (depth >= MAX_DEPENDENCY_DEPTH) return false;
  return opt.dependsOn.some((dep) => {
    if (!dep.in.includes(read(dep.key) as SettingValue)) return false;
    const parent = getOption(dep.key);
    // A clause naming a key that isn't in the registry can't be evaluated any
    // further; the value check above is all we have, and it passed.
    return parent ? optionEnabled(parent, read, depth + 1) : true;
  });
}

/**
 * Human-readable "why is this greyed out" line for an inactive setting, built
 * from its own clauses. Deliberately shows dotted keys rather than labels: the
 * settings pane already prints the key under every headline, so this reads as
 * an instruction you can act on rather than a riddle about which row to find.
 */
export function dependencyHint(opt: SettingOption): string {
  if (!opt.dependsOn?.length) return '';
  const clauses = opt.dependsOn.map((dep) => {
    const values = dep.in.map((v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)));
    return `${dep.key} = ${values.join(' or ')}`;
  });
  return `Inactive — needs ${clauses.join(', or ')}.`;
}
