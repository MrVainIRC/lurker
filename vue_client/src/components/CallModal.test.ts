// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// CallModal inherited the voice block that used to sit atop the member list,
// including the op guest-link and join-policy reads. Two things are worth
// pinning with a real mount:
//
//  1. Setup order. The block it came from crashed the whole chat view once via
//     a temporal-dead-zone read from a { immediate: true } watcher (see
//     MemberList.test.ts). The modal replaced those watchers with onMounted
//     fetches, and this mount is what proves setup stays clean.
//  2. The op controls are gated on modes we do not have here — a non-op must
//     never be shown a join-policy picker or a guest-link minter, and with no
//     buffer row at all there are no modes to be an op with.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import CallModal from './CallModal.vue';

vi.mock('../api.js', () => ({
  // Every op read 404s here; the modal must still render its confirm.
  api: vi.fn<() => Promise<never>>(() => Promise.reject(new Error('no server in this test'))),
}));

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('CallModal', () => {
  it('mounts for a channel with empty stores and offers the confirm', async () => {
    const w = mount(CallModal, { props: { networkId: 1, target: '#dev' } });
    await flushPromises();
    expect(w.text()).toContain('Start call');
    // Not an op (no buffer, no modes) → no security controls on screen.
    expect(w.find('.policy').exists()).toBe(false);
    expect(w.find('.guests').exists()).toBe(false);
  });

  it('does not start a call merely by opening', async () => {
    const w = mount(CallModal, { props: { networkId: 1, target: '#dev' } });
    await flushPromises();
    // The whole point of the confirm: opening the modal is inert until the
    // user commits, so a stray header click never opens a microphone.
    expect(w.emitted('close')).toBeUndefined();
  });

  it('frames a DM as an invite rather than a room to join', async () => {
    const w = mount(CallModal, { props: { networkId: 1, target: 'bob' } });
    await flushPromises();
    expect(w.text()).toContain('bob');
    expect(w.find('.policy').exists()).toBe(false);
  });
});
