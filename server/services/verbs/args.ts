// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared argument coercion for the verb handlers. The registry validates scope,
// required-ness and network ownership; what's left is the structural checking
// JSON Schema can't express — empty-after-trim, and "this string becomes one
// IRC parameter, so it must not contain whitespace or CRLF".
//
// These live together rather than inline per verb because the rule has to be
// the same at every call site. conn.raw() already strips CR/LF/NUL before the
// socket, so a stray newline is never an injection — but stripping silently
// rewrites `#x\r\nfoo` into an operation against `#xfoo` and reports { ok:
// true } for a channel the caller never named. Rejecting up front is what turns
// that into an answerable error instead of a wrong success.

/** One IRC parameter: non-empty after trimming, no interior whitespace. */
export function singleToken(
  value: unknown,
  { empty, malformed }: { empty: string; malformed: string },
): { value: string } | { error: string } {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return { error: empty };
  if (/\s/.test(s)) return { error: malformed };
  return { value: s };
}

/** A channel name argument, e.g. "#foo". Any of the four IRC prefixes. */
export function channelArg(value: unknown): { value: string } | { error: string } {
  return singleToken(value, { empty: 'empty-channel', malformed: 'channel-must-be-single-token' });
}
