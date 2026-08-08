// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// This file exists because of a bug it would have caught: the guest-links
// watcher runs with { immediate: true } during setup and evaluates `isOp` →
// `selfModes` — when `selfModes` was declared BELOW that watcher, the
// temporal-dead-zone ReferenceError crashed MemberList's setup, and with it
// the entire chat view (clicking any buffer rendered nothing). Only a real
// mount exercises setup-time evaluation order, so this mounts the real
// component.

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
    // No buffer → no call affordances, and crucially: no crash.
    expect(w.find('.members-head').exists()).toBe(false);
  });
});
