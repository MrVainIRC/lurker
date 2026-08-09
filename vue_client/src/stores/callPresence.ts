// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Tracks which channels currently have an active voice call, so the UI can show
// a live participant count beside the header phone button even for users who
// are not in the call. Fed two ways:
//   - live deltas: the server's `call-presence` frame (driven by LiveKit
//     webhooks, see routes/voice.ts broadcastCallPresence)
//   - snapshots: hydrate() on each (re)connect edge, because the frame stream
//     only carries deltas — a client that connects mid-call would otherwise
//     never see the badge (see useCallPresenceHydration).
// Channel-only and same-instance by design; DM calls broadcast no presence.

import { defineStore } from 'pinia';
import { api } from '../api.js';

function key(networkId: number | null, target: string): string {
  return `${networkId ?? ''}::${target.toLowerCase()}`;
}

// Per-network delta generation, bumped on every live `call-presence` frame.
// hydrate() snapshots are fetched over REST while frames keep arriving on the
// WS — an in-flight snapshot that resolves AFTER a delta is older than what it
// would overwrite, so it must be dropped. Module-scoped: bookkeeping, not UI
// state.
const deltaGen = new Map<number, number>();

export const useCallPresenceStore = defineStore('callPresence', {
  state: () => ({
    // `${networkId}::${lowercased target}` → participant count (absent = no call).
    counts: {} as Record<string, number>,
  }),
  getters: {
    countFor:
      (s) =>
      (networkId: number | null, target: string): number =>
        s.counts[key(networkId, target)] ?? 0,
  },
  actions: {
    /** Apply a live delta (a `call-presence` frame). */
    set(networkId: number, target: string, count: number) {
      deltaGen.set(networkId, (deltaGen.get(networkId) ?? 0) + 1);
      this.apply(networkId, target, count);
    },

    apply(networkId: number, target: string, count: number) {
      const k = key(networkId, target);
      if (count > 0) this.counts[k] = count;
      else delete this.counts[k];
    },

    /** Replace this network's known call counts with a fresh server snapshot —
     *  unless a live delta arrived while the snapshot was in flight, in which
     *  case the snapshot is the STALER source and is dropped. Best-effort: on
     *  fetch failure we keep whatever deltas have arrived. */
    async hydrate(networkId: number) {
      const genAtFetch = deltaGen.get(networkId) ?? 0;
      let calls: Array<{ target: string; count: number }>;
      try {
        const r = await api<{ calls: Array<{ target: string; count: number }> }>(
          `/api/voice/presence?networkId=${networkId}`,
        );
        calls = r.calls ?? [];
      } catch {
        return;
      }
      if ((deltaGen.get(networkId) ?? 0) !== genAtFetch) return; // deltas are newer
      // Drop stale entries for this network before applying the snapshot, so a
      // call that ended while we were away clears rather than lingering.
      const prefix = `${networkId}::`;
      for (const k of Object.keys(this.counts)) if (k.startsWith(prefix)) delete this.counts[k];
      for (const c of calls) this.apply(networkId, c.target, c.count);
    },
  },
});
