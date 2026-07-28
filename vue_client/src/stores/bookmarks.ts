// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { socketSend } from '../composables/useSocket.js';

// Two-track state: a lightweight `Set<messageId>` always in memory, used by the
// message context menu to flip "Save" ↔ "Remove bookmark" without a network
// call. The heavyweight paginated `items` list is lazy-loaded by the
// BookmarksModal via REST. Adds invalidate `items` so the next modal open
// refetches, since we don't have the full row payload from the echo alone.
//
// The Set is a cache of what we've SEEN, not a mirror of what the account owns.
// It used to be seeded wholesale by a `bookmark-ids-snapshot` frame at connect,
// which shipped every id the account had ever saved — the one piece of connect
// state that grows without bound. Now each message row carries its own
// `bookmarked` flag, so the Set fills in from the backlog/history pages the
// client was going to render anyway, and an id we haven't seen is simply one
// whose line isn't on screen to label. `isSaved` is only ever asked about a
// message the user is looking at, which is exactly what the Set covers.
const PAGE_SIZE = 50;

// The wire shape of a `GET /api/bookmarks` row (`db/bookmarks.ts`
// listBookmarksForUser), which is deliberately the same shape highlights and
// search return so one HistoryMessageRow renders all three.
//
// `text`/`time` are the real field names. This used to declare `body`/`createdAt`,
// which the server has never sent; it went unnoticed because the modal reads the
// row through HistoryMessageRow's own type and nothing ever touched the two
// phantom fields.
export interface BookmarkMessage {
  id: number;
  networkId: number;
  target: string;
  nick: string;
  text?: string;
  time?: string;
  networkName?: string;
  // Sender hostmask, when known — drives client-side ignore filtering.
  userhost?: string | null;
  [key: string]: unknown;
}

export const useBookmarksStore = defineStore('bookmarks', {
  state: () => ({
    ids: new Set<number>(),
    items: [] as BookmarkMessage[],
    nextBefore: null as number | null,
    loading: false,
    error: '',
    listDirty: true,
  }),
  getters: {
    hasMore: (state) => state.nextBefore != null,
    isSaved: (state) => (messageId: number | string) => state.ids.has(Number(messageId)),
    count: (state) => state.ids.size,
  },
  actions: {
    // Harvest the `bookmarked` flags off a page of message rows. MERGES rather
    // than replaces: each page only knows about its own slice, so a later page
    // must not evict what an earlier one taught us. Unbookmarking is the echo's
    // job (`applyUpdate`), never a page's silence.
    noteFromEvents(events: Array<{ id?: number | string | null; bookmarked?: boolean }>) {
      if (!Array.isArray(events)) return;
      for (const e of events) {
        if (!e?.bookmarked || e.id == null) continue;
        const n = Number(e.id);
        if (Number.isFinite(n)) this.ids.add(n);
      }
    },
    applyUpdate({ messageId, saved }: { messageId: number | string; saved: boolean }) {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return;
      if (saved) {
        if (!this.ids.has(id)) {
          this.ids.add(id);
          this.listDirty = true;
        }
      } else {
        if (this.ids.delete(id)) {
          // Splice out of the loaded page so the modal updates immediately.
          const idx = this.items.findIndex((m) => m.id === id);
          if (idx >= 0) this.items.splice(idx, 1);
        }
      }
    },
    toggle(message: { id?: number | string | null }) {
      if (!message || message.id == null) return;
      const id = Number(message.id);
      if (!Number.isFinite(id)) return;
      if (this.ids.has(id)) {
        socketSend({ type: 'unset-bookmark', messageId: id });
      } else {
        socketSend({ type: 'set-bookmark', messageId: id });
      }
    },
    // Every row in the saved-messages list is saved by definition — the REST
    // rows carry no `bookmarked` flag because the endpoint returns nothing else.
    noteFromList(items: Array<{ id?: number | string | null }>) {
      for (const m of items || []) {
        if (m?.id == null) continue;
        const n = Number(m.id);
        if (Number.isFinite(n)) this.ids.add(n);
      }
    },
    remove(messageId: number | string) {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return;
      socketSend({ type: 'unset-bookmark', messageId: id });
    },
    async loadInitial() {
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(`/api/bookmarks?limit=${PAGE_SIZE}`);
        this.items = items || [];
        this.nextBefore = nextBefore ?? null;
        this.listDirty = false;
        this.noteFromList(this.items);
      } catch (e: any) {
        this.error = e.message || 'failed to load bookmarks';
      } finally {
        this.loading = false;
      }
    },
    async loadMore() {
      if (this.loading || this.nextBefore == null) return;
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(
          `/api/bookmarks?limit=${PAGE_SIZE}&before=${this.nextBefore}`,
        );
        this.items = this.items.concat(items || []);
        this.nextBefore = nextBefore ?? null;
        this.noteFromList(items || []);
      } catch (e: any) {
        this.error = e.message || 'failed to load more bookmarks';
      } finally {
        this.loading = false;
      }
    },
    async ensureLoaded() {
      if (this.listDirty || this.items.length === 0) {
        await this.loadInitial();
      }
    },
  },
});
