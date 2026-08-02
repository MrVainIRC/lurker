// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The one list of every store holding per-buffer state, and the two lifecycle
// sweeps over it.
//
// Why this exists: per-buffer client state is scattered across ~10 stores
// (plus module-level Maps inside them), and the old `buffer-closed` handler
// cleaned exactly four — the rest leaked stale entries keyed by a buffer
// nothing would ever reference again. That's the client-side twin of the
// server bug class the buffers registry was built to kill: state keyed by a
// name, orphaned when the name goes away. Every store that keys anything by
// buffer joins this list by implementing `dropBuffer` (and `rekeyBuffer`, the
// rename hook — consumed when `buffer-renamed` lands); adding per-buffer state
// without joining is the bug this file exists to make visible in review.
//
// The participants are getter thunks (not instances) because Pinia stores can
// only be instantiated once an active pinia exists — these run inside socket
// handlers, long after app init.

import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { usePinsStore } from '../stores/pins.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';

export interface BufferLifecycleParticipant {
  /** Remove every trace of (networkId, target) from this store. */
  dropBuffer(networkId: number | string | null, target: string): void;
  /** Move every trace of (networkId, from) to (networkId, to). */
  rekeyBuffer(networkId: number | string | null, from: string, to: string): void;
}

// Deliberately NOT registered: search scope (a frozen display string, going
// stale is cosmetic), whois/nickNotes/relayBots (nick-keyed, not
// buffer-keyed — a DM rename's nick side is the rename feature's concern),
// bookmarks/highlights (message-id-keyed; rows outlive their buffer by
// design).
const participants: Array<() => BufferLifecycleParticipant> = [
  () => useBuffersStore(),
  () => useNetworksStore(),
  () => useNavHistoryStore(),
  () => useRecentBuffersStore(),
  () => useDraftStore(),
  () => useInputHistoryStore(),
  () => usePinsStore(),
  () => useNicklistCollapseStore(),
  () => useChannelNotifyStore(),
];

/** The buffer is gone (buffer-closed): sweep every participating store. */
export function bufferClosed(networkId: number | string | null, target: string): void {
  for (const get of participants) get().dropBuffer(networkId, target);
}

/** The buffer changed names (buffer-renamed, same id): rekey every
 *  participating store. The buffers store itself must be rekeyed FIRST — the
 *  other stores' hooks may resolve through it. */
export function bufferRenamed(networkId: number | string | null, from: string, to: string): void {
  for (const get of participants) get().rekeyBuffer(networkId, from, to);
}
