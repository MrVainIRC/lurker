// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Built-in theme presets and the naming rules for saved ones. Shared like the
// settings registry: the client resolves themed keys against these, the server
// validates /api/themes writes against them.
//
// A theme is a snapshot of the `themed` registry keys (shared/settingsRegistry
// THEMED_KEYS). Built-ins are code, not rows: Dark IS the registry defaults
// (computed on demand so a default change never needs a data migration), and
// Light overrides only the literal colors — keys whose default is a var()
// reference (link, self nick, buffer unread/highlight, alt row bg, the mono
// mIRC slots) keep the reference so they track whichever palette is active.

import type { SettingValue } from './settingsRegistry.js';
import { themedDefaults } from './settingsRegistry.js';

export interface ThemePreset {
  /** 'dark' / 'light' for built-ins; the decimal user_themes row id for saved themes. */
  id: string;
  name: string;
  builtin: boolean;
  values: Record<string, SettingValue>;
}

// Name rules for saved themes, enforced in the client and re-validated by the
// server. Reserved names cover the built-ins plus 'default' (what the friend's
// theme-editor spec called the registry-defaults theme before it grew a Light
// sibling and became 'Dark').
export const THEME_NAME_MAX = 40;
export const RESERVED_THEME_NAMES: readonly string[] = Object.freeze(['default', 'dark', 'light']);
export const MAX_THEMES_PER_USER = 50;

// The three settings whose stored value is a theme id. look.theme.mode is a
// mode switch, not a pointer, so it never dangles. Shared because three
// resolvers care: the client resolver, the server's delete-time pointer reset,
// and the import-time pointer rewrite.
export const THEME_POINTER_KEYS: readonly string[] = Object.freeze([
  'look.theme.active',
  'look.theme.light',
  'look.theme.dark',
]);

export function normalizeThemeName(raw: string): string {
  return raw.trim();
}

/**
 * Case-fold for theme-name comparisons. ASCII-only ON PURPOSE: the server's
 * uniqueness domain is SQLite COLLATE NOCASE, which folds only A-Z, so a
 * Unicode-aware toLowerCase() here would call two names "the same theme" that
 * the server happily stores side by side (and vice versa would overwrite one).
 */
export function foldThemeName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** '' when valid, else the reason the name is rejected. */
export function themeNameError(raw: string): string {
  const name = normalizeThemeName(raw);
  if (!name) return 'theme name is required';
  if (name.length > THEME_NAME_MAX)
    return `theme name must be ${THEME_NAME_MAX} characters or fewer`;
  if (RESERVED_THEME_NAMES.includes(foldThemeName(name)))
    return `"${name}" is a reserved theme name`;
  return '';
}

// The Light palette, from two sources:
//
// NEUTRALS + SEMANTIC COLORS follow the "Monokai Light" tmTheme (the classic
// Sublime Monokai palette adapted to white — the closest thing to an upstream
// light Monokai). Its exact value is used wherever it clears WCAG 3:1 on
// white; the rest (that port kept several dark-theme accents verbatim) are
// darkened along their own hue until they do: orange #FD971F→#d57f1a, green
// #6AAF19→#63a317, cyan #28C6E4→#20a0b9, purple #AE81FF→#a77cf5, comment gray
// #9F9F8F→#949485. The tmTheme defines no yellow, so `warn` keeps the OKLCH
// derivation below.
//
// NICK + mIRC PALETTES stay the OKLCH mapping the iOS client uses for its
// light mode (lurker-ios NickColor.swift: Monokai Pro hues preserved exactly,
// lightness remapped, everything ≥3:1): the tmTheme has no counterpart to the
// 19-hue nick spread, and the mIRC chromatic slots track the nick palette by
// design (colored text harmonises with colored nicks).
const LIGHT_OVERRIDES: Record<string, SettingValue> = {
  'look.color.bg': '#ffffff', //     tmTheme background
  'look.color.bg_soft': '#ededed', // tmTheme inactiveSelection
  'look.color.fg': '#000000', //     tmTheme foreground
  'look.color.fg_muted': '#949485', // tmTheme comment #9F9F8F, clamped to 3:1
  'look.color.accent': '#a77cf5', // tmTheme purple #AE81FF, clamped to 3:1
  'look.color.good': '#63a317', //   tmTheme green #6AAF19, clamped to 3:1
  'look.color.warn': '#a68500', //   OKLCH light of #f9d978 (no tmTheme yellow)
  'look.color.bad': '#f92672', //    tmTheme pink, exact (3.79:1)
  'look.color.border': '#e0e0e0', // tmTheme invisibles
  'look.color.message.alt_fg': '#3a3a3a', // slightly dimmed from the black fg
  // Same role pairing as dark (owner=bad, op=accent, voice=good).
  'look.color.member.owner': '#f92672', //  tmTheme pink, exact
  'look.color.member.admin': '#d57f1a', //  tmTheme orange #FD971F, clamped
  'look.color.member.op': '#a77cf5', //     tmTheme purple, clamped
  'look.color.member.halfop': '#20a0b9', // tmTheme cyan #28C6E4, clamped
  'look.color.member.voice': '#63a317', //  tmTheme green, clamped
  // Same 19 hues as the dark nick palette, same order, lightness remapped.
  'look.nick.colors': [
    '#c40553',
    '#b95417',
    '#a78500',
    '#5f9118',
    '#00919e',
    '#7260b6',
    '#b52d55',
    '#9a5f30',
    '#a68500',
    '#688f2d',
    '#3d8f9b',
    '#7061b1',
    '#c12d5b',
    '#b66621',
    '#759247',
    '#409ba9',
    '#7767bd',
    '#4268c5',
    '#3163c0',
  ],
  // Chromatic slots take the light variant of the same nick-palette hue the
  // dark default borrows; the mono slots keep their var() derivations. Slot 1
  // stays literal black — correct on a light canvas, and still never var(--bg).
  'look.color.mirc_colors': [
    'var(--fg)', //                                       0  white
    '#000000', //                                         1  black — NOT var(--bg)
    '#3163c0', //                                         2  navy
    '#5f9118', //                                         3  green
    '#c40553', //                                         4  red
    '#b52d55', //                                         5  maroon
    '#7260b6', //                                         6  purple
    '#b95417', //                                         7  orange
    '#a78500', //                                         8  yellow
    '#688f2d', //                                         9  lime
    '#00919e', //                                         10 teal
    '#409ba9', //                                         11 cyan
    '#4268c5', //                                         12 blue
    '#c12d5b', //                                         13 magenta
    'var(--fg-muted)', //                                 14 gray
    'color-mix(in srgb, var(--fg) 70%, transparent)', //  15 light gray
  ],
};

// Fresh array copies per call. REGISTRY's Object.freeze is shallow and
// LIGHT_OVERRIDES' arrays are module singletons — without copying, every
// consumer of a built-in theme would hold write-through references into the
// registry defaults themselves, and one in-place edit (palette[i] = x,
// .splice) by a future consumer (the theme editor) would corrupt the defaults
// and both built-ins for the whole session.
function copyValues(values: Record<string, SettingValue>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

export function builtinThemes(): ThemePreset[] {
  const dark = themedDefaults();
  return [
    { id: 'dark', name: 'Dark', builtin: true, values: copyValues(dark) },
    {
      id: 'light',
      name: 'Light',
      builtin: true,
      values: { ...copyValues(dark), ...copyValues(LIGHT_OVERRIDES) },
    },
  ];
}

export function isBuiltinThemeId(id: string): boolean {
  return id === 'dark' || id === 'light';
}

export function getBuiltinTheme(id: string): ThemePreset | null {
  return builtinThemes().find((t) => t.id === id) || null;
}
