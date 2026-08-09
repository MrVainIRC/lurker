// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Call-presence counts feed the header phone button's participant count. These lock in the two
// behaviors that matter: live deltas fold case-insensitively into the same key
// a buffer lookup uses, and a hydrate() snapshot REPLACES the network's counts
// (a call that ended while this client had no socket must clear, not linger).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));

import { useCallPresenceStore } from './callPresence.js';

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('callPresence store', () => {
  it('set() folds target case and clears at zero', () => {
    const s = useCallPresenceStore();
    s.set(1, '#Dev', 2);
    expect(s.countFor(1, '#dev')).toBe(2);
    expect(s.countFor(1, '#DEV')).toBe(2);
    expect(s.countFor(2, '#dev')).toBe(0); // scoped by network
    s.set(1, '#dev', 0);
    expect(s.countFor(1, '#Dev')).toBe(0);
  });

  it('hydrate() replaces the network snapshot, clearing calls that ended', async () => {
    const s = useCallPresenceStore();
    s.set(1, '#ended', 3);
    s.set(2, '#other-network', 1);
    h.api.mockResolvedValueOnce({ calls: [{ target: '#fresh', count: 2 }] });
    await s.hydrate(1);
    expect(s.countFor(1, '#ended')).toBe(0); // stale entry cleared
    expect(s.countFor(1, '#fresh')).toBe(2);
    expect(s.countFor(2, '#other-network')).toBe(1); // other networks untouched
  });

  it('hydrate() keeps existing deltas when the snapshot fetch fails', async () => {
    const s = useCallPresenceStore();
    s.set(1, '#dev', 2);
    h.api.mockRejectedValueOnce(new Error('offline'));
    await s.hydrate(1);
    expect(s.countFor(1, '#dev')).toBe(2);
  });
});
