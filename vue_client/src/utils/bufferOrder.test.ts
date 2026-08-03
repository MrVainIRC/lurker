// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { flattenBufferOrder, flattenUnreadOrder } from './bufferOrder.js';

// Lightweight duck-typed fakes matching the store interfaces bufferOrder reads.
function makeBuffers(byNetwork: Record<string, string[]>, unread: Record<string, number> = {}) {
  return {
    forNetwork: (id: string | number) =>
      (byNetwork[String(id)] || []).map((target) => ({ target })),
    byKey: (key: string) => (key in unread ? { unread: unread[key] } : null),
  };
}
function makePins(byNetwork: Record<string, string[]>) {
  return { forNetwork: (id: string | number) => byNetwork[String(id)] ?? null };
}

// The activeKey of a network's server pseudo-buffer: `${id}::` + `:server:${id}`,
// i.e. a triple colon (network id, `::` separator, `:server:<id>` target).
const srvKey = (id: number) => `${id}:::server:${id}`;

describe('flattenBufferOrder', () => {
  it('orders each network: server first, pinned (stored order), then channels then DMs alphabetically', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }, { id: 2 }],
      buffers: makeBuffers({
        '1': ['#zeta', '#alpha', 'bob', 'amy', '#pinned', 'dm_pinned'],
        '2': ['#chan2'],
      }),
      pins: makePins({ '1': ['#pinned', 'dm_pinned'] }),
    });
    expect(order.map((e) => e.key)).toEqual([
      srvKey(1),
      '1::#pinned',
      '1::dm_pinned',
      '1::#alpha',
      '1::#zeta',
      '1::amy',
      '1::bob',
      srvKey(2),
      '2::#chan2',
    ]);
    // Every real entry nav-groups by its own network id.
    expect(order.every((e) => e.groupId === e.networkId)).toBe(true);
  });

  it('ignores pinned targets that no longer exist as buffers', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#real'] }),
      pins: makePins({ '1': ['#ghost', '#real'] }), // #ghost has no buffer
    });
    expect(order.map((e) => e.target)).toEqual([':server:1', '#real']);
  });
});

describe('flattenUnreadOrder', () => {
  it('keeps only entries whose buffer has unread > 0, server pseudo-buffers included', () => {
    const args = {
      networks: [{ id: 1 }],
      buffers: makeBuffers(
        { '1': ['#busy', '#quiet'] },
        { '1::#busy': 3, '1::#quiet': 0, [srvKey(1)]: 1 },
      ),
      pins: makePins({}),
    };
    expect(flattenUnreadOrder(args).map((e) => e.key)).toEqual([srvKey(1), '1::#busy']);
  });
});
