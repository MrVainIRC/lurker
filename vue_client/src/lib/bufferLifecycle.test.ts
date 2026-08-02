// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The property this file pins: EVERY store holding per-buffer state is swept
// by one bufferClosed() call, and rekeyed by one bufferRenamed() call. The
// old buffer-closed handler cleaned four stores of ~ten; a participant that
// forgets its hooks (or a new store that never joins the registry) should
// fail here, loudly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
}));

import { bufferClosed, bufferRenamed } from './bufferLifecycle.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { usePinsStore } from '../stores/pins.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';

const NET = 7;
const TARGET = '#lifecycle';
const KEY = `${NET}::${TARGET}`;

function seedEverything() {
  useBuffersStore().ensure(NET, TARGET, 42);
  useNetworksStore().activeKey = KEY;
  useNavHistoryStore().stack = [KEY, `${NET}::#other`];
  useNavHistoryStore().index = 0;
  useRecentBuffersStore().keys = [KEY, `${NET}::#other`];
  useDraftStore().drafts[KEY] = 'half-typed';
  useInputHistoryStore().seed(NET, TARGET, ['first line']);
  usePinsStore().byNetwork[NET] = [TARGET, '#other'];
  useNicklistCollapseStore().byNetwork[NET] = { [TARGET]: true };
  useChannelNotifyStore().byNetwork[NET] = { [TARGET]: { notifyAlways: true } };
}

// One assertion per participating store, so a regression names its store.
function presence() {
  return {
    buffer: !!useBuffersStore().buffers[KEY],
    activeKey: useNetworksStore().activeKey === KEY,
    navHistory: useNavHistoryStore().stack.includes(KEY),
    recent: useRecentBuffersStore().keys.includes(KEY),
    draft: KEY in useDraftStore().drafts,
    inputHistory: useInputHistoryStore().forBuffer(NET, TARGET).length > 0,
    pin: usePinsStore().byNetwork[NET]?.includes(TARGET) ?? false,
    nicklist: TARGET in (useNicklistCollapseStore().byNetwork[NET] ?? {}),
    notify: TARGET in (useChannelNotifyStore().byNetwork[NET] ?? {}),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('bufferClosed', () => {
  it('sweeps every participating store in one call', () => {
    seedEverything();
    expect(Object.values(presence()).every(Boolean)).toBe(true);

    bufferClosed(NET, TARGET);

    expect(presence()).toEqual({
      buffer: false,
      activeKey: false,
      navHistory: false,
      recent: false,
      draft: false,
      inputHistory: false,
      pin: false,
      nicklist: false,
      notify: false,
    });
    // Neighbors survive the sweep.
    expect(useNavHistoryStore().stack).toEqual([`${NET}::#other`]);
    expect(usePinsStore().byNetwork[NET]).toEqual(['#other']);
  });

  it('resolves a divergently-cased close target onto the open buffer', () => {
    seedEverything();
    bufferClosed(NET, '#LIFECYCLE');
    expect(useBuffersStore().buffers[KEY]).toBeUndefined();
  });
});

describe('bufferRenamed', () => {
  it('moves every participating store onto the new name, keeping the id', () => {
    seedEverything();
    const RENAMED = '#reborn';
    const NEW_KEY = `${NET}::${RENAMED}`;

    bufferRenamed(NET, TARGET, RENAMED);

    const buffers = useBuffersStore();
    expect(buffers.buffers[KEY]).toBeUndefined();
    expect(buffers.buffers[NEW_KEY]?.target).toBe(RENAMED);
    // The identity survives the rename — that's the entire point of the id.
    expect(buffers.buffers[NEW_KEY]?.id).toBe(42);
    expect(useNetworksStore().activeKey).toBe(NEW_KEY);
    expect(useNavHistoryStore().stack[0]).toBe(NEW_KEY);
    expect(useRecentBuffersStore().keys[0]).toBe(NEW_KEY);
    expect(useDraftStore().drafts[NEW_KEY]).toBe('half-typed');
    expect(useInputHistoryStore().forBuffer(NET, RENAMED)).toEqual(['first line']);
    expect(usePinsStore().byNetwork[NET]).toEqual([RENAMED, '#other']);
    expect(useNicklistCollapseStore().byNetwork[NET]?.[RENAMED]).toBe(true);
    expect(useChannelNotifyStore().byNetwork[NET]?.[RENAMED]).toEqual({ notifyAlways: true });
  });

  it('the id index follows the rename (frames by id land on the new key)', () => {
    seedEverything();
    bufferRenamed(NET, TARGET, '#reborn');
    // A later frame carrying bufferId 42 must resolve to the renamed buffer
    // even under the old name — the id fast path in ensureBuffer.
    const buf = useBuffersStore().ensure(NET, TARGET, 42);
    expect(buf.target).toBe('#reborn');
  });
});
