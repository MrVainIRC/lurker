// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter, type Router } from 'vue-router';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore, bufferKey } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';
import { connected } from './useSocket.js';
import { whenReady } from '../lib/deferredReady.js';

// Two-way binding between the active buffer and the URL (#744), so every buffer
// has a direct link and browser back/forward walks between them. On an installed
// PWA that is also what makes the platform's back gesture work — the iOS
// left-edge swipe and the Android system back both just call history.back() —
// which is why #200 needs no gesture code of its own.
//
// This sits alongside navHistory (#309, Cmd+[ / ]) rather than replacing it. The
// two are deliberately independent: navHistory is a BUFFER trail with its own
// cursor, dead-buffer skipping and a 100-entry cap; browser history is the
// LOCATION stack. Neither drives the other, so they cannot desync. A hop driven
// from here lands in navHistory as an ordinary visit (recordVisit's
// consecutive-dupe collapse absorbs the degenerate case), and navHistory's own
// back()/forward() go through activate() and so push a URL like any other
// navigation — which is right, since a nav-history hop IS a navigation.

// The buffer id of a navigation we've started but that hasn't landed yet.
//
// router.push resolves ASYNCHRONOUSLY, so `route.params.id` still reports the
// old buffer for a tick after a push is issued — long enough for the activeKey
// watcher below to check the route, see a stale id, and push the same buffer a
// second time. Opening a buffer has two legitimate callers (the watcher, and
// MobileChat's list tap, which has to cover re-tapping the buffer that is
// already active), so both go through here and the guard is this synchronous
// value rather than the lagging route.
let inFlightId: number | null = null;

/** Navigate to a buffer, unless we're already there or already on the way. */
export function pushBuffer(router: Router, id: number): void {
  if (inFlightId === id) return;
  // Already the current route. vue-router would reject this as a duplicated
  // navigation anyway, but it is reached on every single buffer open — the
  // watcher pushes, the route lands, and the click handler then asks for the
  // same place ~30ms later — so it is worth not starting the navigation at all.
  if (router.currentRoute.value.params.id === String(id)) return;
  inFlightId = id;
  void router.push(`/buffer/${id}`).finally(() => {
    if (inFlightId === id) inFlightId = null;
  });
}

export function useBufferRoute(): void {
  const router = useRouter();
  const route = useRoute();
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const toasts = useToastsStore();

  // Cleanup for the deferred cold-start resolver below. Only ever one in
  // flight: a new route supersedes whatever the last one was waiting for.
  // Null out BEFORE invoking so a cancel that navigates (the timeout path
  // replaces to `/`) can't re-enter this and cancel its own successor.
  let cancelPending: (() => void) | null = null;
  function clearPending(): void {
    const cancel = cancelPending;
    cancelPending = null;
    cancel?.();
  }

  // The id currently in the URL, or null at `/`. Params are strings; anything
  // non-numeric (a hand-typed /buffer/foo) is treated as "no buffer" rather
  // than parsed to NaN, which would silently match nothing downstream.
  function routeId(): number | null {
    const raw = route.params.id;
    if (typeof raw !== 'string' || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  }

  // --- Outbound: active buffer -> URL -------------------------------------
  //
  // Watches the (key, id) PAIR, not activeKey alone. A buffer created
  // optimistically — the profile modal's "Send DM" to a nick never DM'd before
  // — has no id until the server answers (see Buffer.id), and there is no URL
  // to name it with until then. So we hold: the URL stays on the previous
  // buffer, and the moment the id lands this watcher re-fires and pushes. Push,
  // not replace: the buffer we came from has to keep its history entry, or
  // back/swipe would skip straight past it.
  watch(
    // Three distinct states, not two: 'none' (nothing active) and 'pending' (a
    // buffer is active but has no server id yet) must not collapse into one
    // value, or the transition between them wouldn't fire the watcher and the
    // URL would be left naming a buffer that is gone.
    (): 'none' | 'pending' | number => {
      const key = networks.activeKey;
      if (!key) return 'none';
      return buffers.byKey(key)?.id ?? 'pending';
    },
    (id) => {
      if (id === 'none') {
        // The active buffer went away (closed, or its network was removed) —
        // activeKey only nulls in those cases. Replace rather than push: this
        // is involuntary, and a dead buffer must not stay reachable by pressing
        // Forward.
        clearPending();
        if (route.path !== '/') void router.replace('/');
        return;
      }
      if (id === 'pending') return; // no server id yet — see above
      // Already there. This is the loop guard for the inbound direction: a
      // route-driven activation produces an outbound target identical to the
      // route that caused it, and stops here.
      if (routeId() === id || inFlightId === id) return;
      clearPending();
      pushBuffer(router, id);
    },
  );

  // --- Inbound: URL -> active buffer --------------------------------------
  //
  // Resolution goes through the store's `byId` getter, NOT the module-level
  // bufferKeyForId index: that Map is invisible to Vue, so a watcher built on
  // it would never re-fire when the ids finally land — and on a cold launch
  // they land after the socket connects, which is the one case this whole
  // deferral exists for.
  function open(id: number): boolean {
    const buf = buffers.byId(id);
    if (!buf) return false;
    const key = bufferKey(buf.networkId, buf.target);
    if (key !== networks.activeKey) buffers.activate(buf.networkId, buf.target);
    return true;
  }

  watch(
    () => route.params.id,
    () => {
      const id = routeId();
      clearPending();
      if (id == null) return; // at `/` — see note below on not deactivating

      if (open(id)) return;
      // Unknown id. Either a cold start where buffers haven't arrived over the
      // WS yet, or a link to a buffer this account no longer has. Wait for the
      // first, time out into the second.
      cancelPending = whenReady(
        () => connected.value && buffers.byId(id) != null,
        () => open(id),
        () => {
          // Say so rather than leaving the user on an empty shell wondering,
          // and drop the URL back to `/` so it stops claiming a buffer we can't
          // show. Guarded on the id still being the one in the URL: by now the
          // user may have navigated somewhere that works.
          if (routeId() !== id) return;
          toasts.push({
            kind: 'info',
            title: 'Couldn’t open that conversation',
            body: '',
            ttlMs: 5000,
          });
          void router.replace('/');
        },
      );
    },
    // The first render has to honor whatever the launch URL named — that IS the
    // cold-start deep link — not just later changes.
    //
    // Default 'pre' flush, deliberately: it runs the callback before the
    // component re-renders in the same flush, so the activation is always in
    // place by the time anything paints. A 'sync' flush was tried while chasing
    // a reported flash, and would put activate()'s mark-read, socket sends and
    // hydration inside the route mutation itself — real cost, and the flash
    // turned out to be Safari compositing a cached snapshot during its back
    // gesture, which no flush timing can touch.
    { immediate: true },
  );

  // Navigating to `/` deliberately does NOT deactivate. `/` means "not looking
  // at a buffer" (the mobile list screen), not "no buffer selected": clearing
  // activeKey would run activate()'s mark-read, divider snapshot and detached
  // cleanup for what is only a change of screen.

  onBeforeUnmount(clearPending);
}
