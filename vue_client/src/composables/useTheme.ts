// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { watchEffect } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useViewport } from './useViewport.js';

// Maps each settings key to the CSS custom property it controls. Anything in
// here is live-rewritten on :root whenever the settings store changes, so the
// whole UI re-themes immediately when the user edits a key in Settings.
const COLOR_VARS: Record<string, string> = {
  'look.color.bg': '--bg',
  'look.color.bg_soft': '--bg-soft',
  'look.color.fg': '--fg',
  'look.color.fg_muted': '--fg-muted',
  'look.color.accent': '--accent',
  'look.color.link': '--link',
  'look.color.good': '--good',
  'look.color.warn': '--warn',
  'look.color.bad': '--bad',
  'look.color.border': '--border',
  'look.color.message.alt_bg': '--alt-bg',
  'look.color.message.alt_fg': '--alt-fg',
  'look.color.buffer.unread': '--buffer-unread',
  'look.color.buffer.highlight': '--buffer-highlight',
  'look.color.member.owner': '--member-owner',
  'look.color.member.admin': '--member-admin',
  'look.color.member.op': '--member-op',
  'look.color.member.halfop': '--member-halfop',
  'look.color.member.voice': '--member-voice',
};

let installed = false;

// UA hint for scrollbars / form controls / system surfaces, derived from the
// effective background rather than any theme metadata — a hand-picked palette
// deserves the right chrome as much as the built-in Light theme does. Perceived
// luminance (ITU-R BT.601) on plain hex; anything else (var(), color-mix())
// keeps the dark default.
function colorSchemeFor(bg: string): 'light' | 'dark' {
  const hex = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(bg.trim());
  if (!hex) return 'dark';
  const digits = hex[2] ?? hex[1].replace(/./g, (c) => c + c);
  const n = parseInt(digits, 16);
  const luma = 0.299 * ((n >> 16) & 0xff) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff);
  return luma > 140 ? 'light' : 'dark';
}

export function useTheme(): void {
  if (installed) return;
  installed = true;
  const settings = useSettingsStore();
  const { isMobile } = useViewport();
  const root = document.documentElement;

  watchEffect(() => {
    for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
      root.style.setProperty(cssVar, String(settings.effective(key)));
    }
    root.style.setProperty('--mono', String(settings.effective('look.font.family')));
    // Mobile gets its own size so a large desktop setting (and the large icons
    // that come with it) doesn't have to follow you onto a phone. The viewport
    // breakpoint flips live, so resizing across it re-applies the right value.
    const fontSizeKey = isMobile.value ? 'look.font.size.mobile' : 'look.font.size';
    root.style.setProperty('--font-size', `${settings.effective(fontSizeKey)}px`);
    root.style.setProperty('--font-weight', String(settings.effective('look.font.weight')));
    const macSmoothing = !!settings.effective('look.font.smoothing_macos');
    root.style.setProperty(
      '--font-smoothing-webkit',
      macSmoothing ? 'subpixel-antialiased' : 'auto',
    );
    root.style.setProperty('--font-smoothing-moz', 'auto');
    root.style.colorScheme = colorSchemeFor(String(settings.effective('look.color.bg')));
  });
}
