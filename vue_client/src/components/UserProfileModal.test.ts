// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The modal's no-such-user state (#818).
//
// This file exists because of a bug it would have caught. The failure signal
// was already arriving — irc-framework synthesizes `error: 'not_found'` on
// RPL_ENDOFWHOIS when nothing filled the whois cache, and the component
// already computed `isNotFound` from it — but that computed was only ever
// folded into `isOffline`, so nothing on screen said the lookup had failed.
// The modal rendered a name, a note prompt, and nothing else: exactly what a
// profile we simply have no details for looks like. Only a mounted component
// can see that difference, so this mounts the real one and reads the DOM.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { useWhoisStore } from '../stores/whois.js';
import UserProfileModal from './UserProfileModal.vue';

const NET = 1;

function open(nick: string) {
  return mount(UserProfileModal, { props: { nick, networkId: NET } });
}

describe('UserProfileModal — no such user', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('says so when the whois came back not-found', () => {
    useWhoisStore().applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(open('fartboy').text()).toContain("fartboy isn't on this network.");
  });

  it('shows the waiting state instead while the reply is still out', () => {
    // Nothing cached at all is the genuinely-in-the-dark case, and it must not
    // be reported as a miss — the two are what this whole issue is about
    // telling apart.
    const w = open('fartboy');
    expect(w.text()).toContain('Waiting for whois reply');
    expect(w.text()).not.toContain("isn't on this network");
  });

  it('says nothing of the sort once an identity lands', () => {
    useWhoisStore().applyResult(NET, { nick: 'someone', ident: 'u', hostname: 'h.test' });
    const w = open('someone');
    expect(w.text()).not.toContain("isn't on this network");
    expect(w.text()).not.toContain('Waiting for whois reply');
  });

  it('reads the missing nick as offline, not unknown', () => {
    // The header dot is the other half. With no MONITOR data a not-found nick
    // fell through to "Unknown" — the one status we can rule out — which is
    // why the dot could not be left to carry this on its own.
    useWhoisStore().applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    const dot = open('fartboy').find('.dot');
    expect(dot.classes()).toContain('offline');
    expect(dot.attributes('aria-label')).toBe('Offline');
  });

  it('goes back to waiting while a fresh lookup is out over a stale miss', () => {
    // A cached miss is stale the moment a refresh goes out — they may have
    // connected since. Asserting "isn't on this network" through that
    // round-trip is a definite claim about a fact we're in the middle of
    // re-checking, so the in-flight lookup demotes it.
    const whois = useWhoisStore();
    whois.applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    whois.openViewer(NET, 'fartboy');

    const w = open('fartboy');
    expect(w.text()).toContain('Waiting for whois reply');
    expect(w.text()).not.toContain("isn't on this network");
  });

  it('hides Send DM for a nick that is not there', () => {
    // A DM would bounce. This already worked via isOffline; pinned so the
    // presence rework above can't quietly undo it.
    useWhoisStore().applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(open('fartboy').find('button[title="Send DM"]').exists()).toBe(false);
  });
});
