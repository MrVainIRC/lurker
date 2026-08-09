// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// This file exists because of a bug it would have caught: a watcher running
// with { immediate: true } during setup evaluated `isOp` → `selfModes` — and
// when `selfModes` was declared BELOW that watcher, the temporal-dead-zone
// ReferenceError crashed MemberList's setup, and with it the entire chat view
// (clicking any buffer rendered nothing). Only a real mount exercises
// setup-time evaluation order, so this mounts the real component.
//
// The voice block that owned those watchers now lives in CallModal (see
// CallModal.test.ts for the same guard); MemberList keeps the test because
// `selfModes` is still computed here for the member context menu, and the
// class of bug belongs to any component that grows a setup-time watcher.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import MemberList from './MemberList.vue';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('MemberList — setup survives a bare mount', () => {
  it('mounts with empty stores (no active buffer) without throwing', async () => {
    const w = mount(MemberList);
    await flushPromises();
    expect(w.find('.members').exists()).toBe(true);
    // Members only — every call affordance moved to the header phone button
    // and CallModal behind it.
    expect(w.find('.members-head').exists()).toBe(false);
    expect(w.find('.call-btn').exists()).toBe(false);
  });
});
