// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which screen the mobile shell shows, as a pure function of the route (#200).
// Kept free of Vue/store deps — like utils/navHistory — so the edge cases below
// are unit-testable without standing up the whole shell.

export type MobileScreen = 'list' | 'buffer' | 'members';

/**
 * `/` → list, `/buffer/<id>` → buffer, `/buffer/<id>/members` → members,
 * `/system` → buffer (the app-scoped console).
 *
 * `isMembers` is the route NAME test (`buffer-members`), not a path-suffix
 * sniff — the three screens are three route records.
 *
 * This is DERIVED, never assigned. The shell used to keep it in a ref nudged
 * from four places, which is what let the screen and the URL disagree: the list
 * had no history entry of its own, so a back gesture from it popped to a BUFFER
 * url, and an auto-advance watcher hauled the user into that buffer on top of
 * the list they had just asked for. With one source, that cannot happen.
 *
 * `hasActiveBuffer` is the cold-launch guard. `/buffer/7` is a real screen the
 * moment it routes, but the buffer behind it only arrives over the WS a beat
 * later, and an empty buffer shell in the meantime reads as broken — so hold on
 * the list until there's something to show. (useBufferRoute owns the other end:
 * it drops the URL back to `/` if the id never resolves.)
 */
export function screenForRoute(
  id: unknown,
  isMembers: boolean,
  hasActiveBuffer: boolean,
  isSystem = false,
): MobileScreen {
  // `/system` names the app-scoped buffer without an id — it exists before the
  // server answers, so it stays reachable while disconnected, which is when its
  // connection log is what you want.
  if (isSystem) return 'buffer';
  if (!id || !hasActiveBuffer) return 'list';
  return isMembers ? 'members' : 'buffer';
}
