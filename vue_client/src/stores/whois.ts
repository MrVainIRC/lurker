// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';

// Cache of the most recent `whois_result` for each (network, nick), plus the
// open/close state for the UserProfileModal. The modal mounts once at the top
// of the chat view and watches `viewer.open`, so any call site (slash
// command, nicklist, DM header, message-body nick click) can open it without
// owning the component — same pattern as nickNotes.editor.
//
// The store does NOT persist whois data across page reloads — IRC presence
// is volatile and a stale cache is more misleading than no cache. On open
// the modal triggers a fresh `whois` and re-renders when the result arrives.
function key(networkId: number | string, nick: string) {
  return `${networkId}::${(nick || '').toLowerCase()}`;
}

export interface WhoisData {
  nick?: string;
  ident?: string;
  hostname?: string;
  real_name?: string;
  actual_hostname?: string;
  actual_ip?: string;
  server?: string;
  server_info?: string;
  channels?: string;
  modes?: string;
  account?: string;
  registered_nick?: string;
  operator?: string;
  helpop?: string;
  bot?: string;
  secure?: boolean;
  certfp?: string;
  away?: string;
  idle?: number;
  logon?: number;
  error?: string;
  [key: string]: unknown;
}

export interface WhoisEntry {
  data: WhoisData;
}

export interface WhoisViewerState {
  open: boolean;
  networkId: number | null;
  nick: string;
}

export const useWhoisStore = defineStore('whois', {
  state: () => ({
    byKey: {} as Record<string, WhoisEntry>,
    viewer: { open: false, networkId: null, nick: '' } as WhoisViewerState,
    // The lookup currently in flight, if any. Set when the viewer kicks a
    // WHOIS and cleared when that WHOIS answers (or the viewer closes), so a
    // reopen while the reply is still out doesn't fire a second one.
    refreshingKey: null as string | null,
  }),
  getters: {
    entryFor: (state) => (networkId: number | string, nick: string) =>
      state.byKey[key(networkId, nick)] || null,
  },
  actions: {
    applyResult(networkId: number | string, data: WhoisData) {
      const nick = (data && (data.nick as string)) || '';
      if (!networkId || !nick) return;
      const k = key(networkId, nick);
      this.byKey[k] = { data };
      // The lookup answered — with an identity, or with `error: 'not_found'`
      // when the nick isn't on the network — so it is no longer in flight.
      // Leaving refreshingKey set is what wedged a failed lookup: the slot
      // stayed claimed for the rest of the viewer session, so reopening the
      // same nick never retried it (#818).
      if (this.refreshingKey === k) this.refreshingKey = null;
    },
    openViewer(networkId: number | string, nick: string) {
      if (!networkId || !nick) return;
      const k = key(networkId, nick);
      this.viewer = { open: true, networkId: Number(networkId), nick };
      // Always kick a fresh whois on open. The cached entry (if any) renders
      // immediately for instant feedback; the new data overwrites it when it
      // arrives. Skip only while a lookup for this exact (nick, network) is
      // still out — keeps reopens on the same nick from spamming the server
      // without leaving a failed lookup un-retryable.
      if (this.refreshingKey !== k) {
        this.refreshingKey = k;
        socketSend({ type: 'raw', networkId, line: `WHOIS ${nick}` });
      }
    },
    closeViewer() {
      this.viewer = { open: false, networkId: null, nick: '' };
      this.refreshingKey = null;
    },
  },
});
