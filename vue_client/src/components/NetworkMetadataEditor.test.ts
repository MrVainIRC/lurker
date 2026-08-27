// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { socketSend } from '../composables/useSocket.js';
import { useNetworksStore } from '../stores/networks.js';
import NetworkMetadataEditor from './NetworkMetadataEditor.vue';

describe('NetworkMetadataEditor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });

  it('hydrates the fields from the stable self target after a snapshot', () => {
    const networks = useNetworksStore();
    networks.states[1] = {
      networkId: 1,
      state: 'connected',
      nick: 'NewNick',
      channels: [],
      negotiatedFeatures: { metadata: true, setname: false },
      metadata: {
        OldNick: [{ key: 'display-name', value: 'stale', visibility: '*' }],
        '*': [{ key: 'display-name', value: 'Current name', visibility: '*' }],
      },
    };

    const wrapper = mount(NetworkMetadataEditor, { props: { networkId: 1 } });
    const displayName = wrapper.findAll('input')[1];

    expect(displayName.element.value).toBe('Current name');
  });

  it('uses SET without a value when one field is cleared', async () => {
    const networks = useNetworksStore();
    networks.states[1] = {
      networkId: 1,
      state: 'connected',
      nick: 'Me',
      channels: [],
      negotiatedFeatures: { metadata: true, setname: false },
      metadata: {
        '*': [{ key: 'display-name', value: 'Old name', visibility: '*' }],
      },
    };
    const wrapper = mount(NetworkMetadataEditor, { props: { networkId: 1 } });
    await wrapper.findAll('input')[1].setValue('New name');
    await wrapper.findAll('input')[1].setValue('');
    await wrapper.find('button').trigger('click');

    const displayNameCalls = vi
      .mocked(socketSend)
      .mock.calls.map(([payload]) => payload)
      .filter((payload) => {
        const params = payload.params;
        return payload.type === 'metadata' && Array.isArray(params) && params[0] === 'display-name';
      });
    expect(displayNameCalls.at(-1)).toMatchObject({
      command: 'SET',
      params: ['display-name'],
    });
    expect(displayNameCalls).toHaveLength(1);
  });

  it('sends only the independently changed metadata key', async () => {
    const networks = useNetworksStore();
    networks.states[1] = {
      networkId: 1,
      state: 'connected',
      nick: 'Me',
      channels: [],
      negotiatedFeatures: { metadata: true, setname: false },
      metadata: {},
    };
    const wrapper = mount(NetworkMetadataEditor, { props: { networkId: 1 } });
    await wrapper.findAll('input')[0].setValue('https://example.test/avatar.png');
    await wrapper.find('button').trigger('click');

    const metadataCalls = vi
      .mocked(socketSend)
      .mock.calls.map(([payload]) => payload)
      .filter((payload) => payload.type === 'metadata');
    expect(metadataCalls).toHaveLength(1);
    expect(metadataCalls[0]).toMatchObject({
      command: 'SET',
      params: ['avatar', 'https://example.test/avatar.png'],
    });
  });

  it('does not overwrite a locally edited field when another server value arrives', async () => {
    const networks = useNetworksStore();
    networks.states[1] = {
      networkId: 1,
      state: 'connected',
      nick: 'Me',
      channels: [],
      negotiatedFeatures: { metadata: true, setname: false },
      metadata: {},
    };
    const wrapper = mount(NetworkMetadataEditor, { props: { networkId: 1 } });
    await wrapper.findAll('input')[0].setValue('pending-avatar');

    networks.states[1].metadata = {
      '*': [{ key: 'status', value: 'online', visibility: '*' }],
    };
    await nextTick();

    expect(wrapper.findAll('input')[0].element.value).toBe('pending-avatar');
    expect(wrapper.findAll('input')[3].element.value).toBe('online');
  });
});
