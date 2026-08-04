// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One place to parse/normalize a channel-scope list so the /highlight parser,
// the settings pane, the service, and the DB layer agree on splitting, trimming,
// lowercasing (channel matching is case-insensitive), de-duping, and dropping
// blanks. Previously this logic was reimplemented four times with inconsistent
// casing.

/**
 * The four IRC channel prefixes (RFC 2811 §2.1): `#` global, `&` server-local,
 * `+` no-modes, `!` safe/timestamped.
 *
 * ⚠⚠ Testing only for `#` is the single most-repeated bug in this codebase — it had accumulated
 * in ~30 places in the web client alone (#724), where an `&`/`+`/`!` channel was then treated as
 * a DM: no nicklist, a `probe-presence` fired at the channel name as if it were a nick, nick
 * colouring, whois menu items, and sorting among the DMs. It survived because `&` is server-local
 * and `+`/`!` are historic, so almost every real network only uses `#`.
 *
 * Shared rather than per-tier precisely because the halves disagreeing is what caused the damage:
 * the server has classified all four since `kindForTarget` was written, so every client-side `#`
 * test was a place the two tiers silently parted company.
 *
 * ⚠ This answers "is this the name of a CHANNEL". It is NOT the question a completion trigger
 * asks — that one is "did the user type a `#`", where the character is a literal sigil and
 * widening it would pop a channel picker on any `+` in ordinary prose. Those sites stay `#`-only
 * and say so.
 */
export const CHANNEL_PREFIX_CHARS = '#&+!';
const CHANNEL_PREFIXES = new Set(CHANNEL_PREFIX_CHARS);

export function isChannelTarget(target: string | null | undefined): boolean {
  return typeof target === 'string' && CHANNEL_PREFIXES.has(target[0] ?? '');
}

/** Strip every leading channel sigil — for sort keys and display, never for addressing. */
export function stripChannelPrefix(target: string): string {
  return target.replace(new RegExp(`^[${CHANNEL_PREFIX_CHARS}]+`), '');
}

// Normalize an array of channel names: trim, lowercase, drop blanks, dedupe.
// Non-string entries are ignored.
export function normalizeChannelList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const c = (typeof v === 'string' ? v : '').trim().toLowerCase();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

// Parse a free-form channel list (comma- and/or space-separated) into a
// normalized array.
export function parseChannelList(input: string): string[] {
  return normalizeChannelList(input.split(/[\s,]+/));
}
