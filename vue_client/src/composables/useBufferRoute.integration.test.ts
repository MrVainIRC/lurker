// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The sibling suite mocks vue-router, which makes navigation synchronous and so
// cannot see the bug this file exists for: router.push resolves ASYNCHRONOUSLY,
// and everything that reads `route.params` to decide whether to navigate is
// reading a value that lags a push by a tick. These run against the real router.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

const s = reactive({
  networks: { activeKey: null as string | null },
  buffers: {} as Record<string, { id?: number; networkId: number | null; target: string }>,
});

vi.mock('./useSocket.js', () => ({ connected: { value: true } }));
vi.mock('../stores/networks.js', () => ({ useNetworksStore: () => s.networks }));
vi.mock('../stores/toasts.js', () => ({ useToastsStore: () => ({ push: () => {} }) }));
vi.mock('../stores/buffers.js', () => ({
  useBuffersStore: () => ({
    byKey: (k: string) => s.buffers[k] ?? null,
    byId: (id: number) => Object.values(s.buffers).find((b) => b.id === id) ?? null,
    activate: (networkId: number | null, target: string) => {
      s.networks.activeKey = networkId == null ? target : `${networkId}::${target}`;
    },
  }),
  bufferKey: (networkId: number | null, target: string) =>
    networkId == null ? target : `${networkId}::${target}`,
}));

import { useBufferRoute, pushBuffer } from './useBufferRoute.js';

function known(key: string, id: number): void {
  const sep = key.indexOf('::');
  s.buffers[key] = { networkId: Number(key.slice(0, sep)), target: key.slice(sep + 2), id };
}

/** Let an in-flight navigation actually land, the way a real gesture would. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function mkApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'chat', component: { render: () => null } },
      { path: '/buffer/:id', name: 'buffer', component: { render: () => null } },
      { path: '/buffer/:id/members', name: 'buffer-members', component: { render: () => null } },
    ],
  });
  const app = mount(
    defineComponent({
      setup() {
        useBufferRoute();
        return () => h(RouterView);
      },
    }),
    { global: { plugins: [router] } },
  );
  // Record only once the initial `/` navigation has landed, so `navs` counts
  // what the test does rather than the router booting.
  await router.isReady();
  const navs: string[] = [];
  router.afterEach((to) => navs.push(to.fullPath));
  return { router, app, navs };
}

/** Tap a row in the buffer list: the store activates, the shell navigates. */
async function tapBuffer(
  router: Awaited<ReturnType<typeof mkApp>>['router'],
  key: string,
  id: number,
) {
  s.networks.activeKey = key;
  pushBuffer(router, id); // what MobileChat's openActiveBuffer does
  await settle();
}

beforeEach(() => {
  s.networks.activeKey = null;
  s.buffers = {};
});

describe('useBufferRoute against the real router', () => {
  it('opens a buffer with exactly ONE navigation', async () => {
    known('1::#a', 7);
    const { router, navs } = await mkApp();

    await tapBuffer(router, '1::#a', 7);

    // Two pushes land two history entries for one tap, so the first swipe back
    // appears to do nothing — and the interleaved navigations resolve through
    // an intermediate route naming the PREVIOUS buffer, which is visible as the
    // wrong channel highlighted in the list.
    expect(navs).toEqual(['/buffer/7']);
  });

  it('leaves the active buffer alone when swiping back to the list', async () => {
    known('1::#a', 7);
    known('1::#b', 8);
    const { router, navs } = await mkApp();

    await tapBuffer(router, '1::#a', 7);
    await router.push('/'); // back arrow to the list
    await settle();
    await tapBuffer(router, '1::#b', 8);
    navs.length = 0;

    router.back(); // the swipe
    await settle();

    expect(router.currentRoute.value.fullPath).toBe('/');
    // The list highlights whatever activeKey names. Landing here with #a active
    // — because a stray navigation resolved through /buffer/7 on the way — is
    // the flash of the wrong row reported on device.
    expect(s.networks.activeKey).toBe('1::#b');
    expect(navs).toEqual(['/']);
  });

  it('walks one screen per gesture: members -> buffer -> list', async () => {
    known('1::#a', 7);
    const { router } = await mkApp();

    await tapBuffer(router, '1::#a', 7);
    await router.push('/buffer/7/members');
    await settle();

    router.back();
    await settle();
    expect(router.currentRoute.value.name).toBe('buffer');

    router.back();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe('/');
  });
});
