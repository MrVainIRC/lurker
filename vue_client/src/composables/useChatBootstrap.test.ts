// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// consumeColdStartJump only consults the socket-`connected` flag and the buffers
// store passed to it. Stub useSocket so we control readiness; everything else in
// the bootstrap module is import-safe. The suite has no DOM environment, so we
// install a minimal window (location + history) rather than pull in jsdom.
const h = vi.hoisted(() => ({ connected: { value: false } as { value: boolean } }));
vi.mock('./useSocket.js', () => ({ connected: h.connected }));

import { consumeColdStartJump } from './useChatBootstrap.js';

function installWindow(search: string, pathname = '/'): void {
  const loc = { pathname, search, hash: '' };
  (globalThis as any).window = {
    location: loc,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        const u = new URL(url, 'http://localhost');
        loc.pathname = u.pathname;
        loc.search = u.search;
        loc.hash = u.hash;
      },
    },
  };
}

const currentSearch = (): string => (globalThis as any).window.location.search;

// Stands in for vue-router: consumeColdStartJump strips the deep-link params
// through it now (a raw replaceState left the router's own location holding the
// consumed ?msg, which then leaked into Settings' back target and re-fired the
// jump). Mirrors the URL the same way the real router does.
const replaceCalls: Array<Record<string, string>> = [];
const fakeRouter = () =>
  ({
    replace: ({ query }: { query: Record<string, string> }) => {
      replaceCalls.push(query);
      const qs = new URLSearchParams(query).toString();
      const loc = (globalThis as any).window.location;
      loc.search = qs ? `?${qs}` : '';
      return Promise.resolve();
    },
  }) as any;
const openBuffers = { isOpen: () => true, byId: () => null } as any;
// Resolves buffer 7, for the route form.
const byIdBuffers = {
  isOpen: () => true,
  byId: (id: number) => (id === 7 ? { networkId: 1, target: '#chan', id: 7 } : null),
} as any;

beforeEach(() => {
  h.connected.value = false;
  installWindow('');
});
afterEach(() => {
  delete (globalThis as any).window;
});

describe('consumeColdStartJump — the /buffer/<id> route form', () => {
  // Every other test in this file loads at `/`, so the entire route branch —
  // bufferIdFromPath, consumeRouteJump, its strip and its deliberate silent
  // give-up — went uncovered. That is how a URIError that blanks the whole chat
  // shell got through.
  it('does not throw on a mangled path', () => {
    h.connected.value = true;
    installWindow('', '/buffer/%');

    // `%` survives to the client verbatim and vue-router still matches the
    // route, so this runs; decoding it threw URIError inside setup and left the
    // shell unrendered.
    expect(() =>
      consumeColdStartJump(openBuffers, fakeRouter(), vi.fn<(p: unknown) => void>()),
    ).not.toThrow();
  });

  it('does not throw on a non-numeric id', () => {
    h.connected.value = true;
    installWindow('?msg=42', '/buffer/nonsense');
    expect(() =>
      consumeColdStartJump(openBuffers, fakeRouter(), vi.fn<(p: unknown) => void>()),
    ).not.toThrow();
  });

  it('fires the jump for a resolvable buffer route', () => {
    h.connected.value = true;
    installWindow('?msg=42', '/buffer/7');
    const onJump = vi.fn<(payload: unknown) => void>();

    consumeColdStartJump(byIdBuffers, fakeRouter(), onJump);

    expect(onJump).toHaveBeenCalledWith({
      kind: 'jump',
      networkId: 1,
      target: '#chan',
      messageId: 42,
    });
  });

  it('does not jump when the route names a buffer but no message', () => {
    h.connected.value = true;
    installWindow('', '/buffer/7');
    const onJump = vi.fn<(payload: unknown) => void>();

    consumeColdStartJump(byIdBuffers, fakeRouter(), onJump);

    expect(onJump).not.toHaveBeenCalled();
  });
});

describe('consumeColdStartJump', () => {
  it('fires the jump and strips the params when the app is already ready', () => {
    h.connected.value = true;
    installWindow('?net=1&buf=%23chan&msg=42');
    const onJump = vi.fn<(payload: unknown) => void>();

    consumeColdStartJump(openBuffers, fakeRouter(), onJump);

    expect(onJump).toHaveBeenCalledWith({
      kind: 'jump',
      networkId: 1,
      target: '#chan',
      messageId: 42,
    });
    // Deep-link params are consumed so a refresh doesn't re-jump.
    expect(currentSearch()).toBe('');
  });

  it('passes messageId null for an "open conversation" deep link with no msg', () => {
    h.connected.value = true;
    installWindow('?net=2&buf=alice');
    const onJump = vi.fn<(payload: unknown) => void>();

    consumeColdStartJump(openBuffers, fakeRouter(), onJump);

    expect(onJump).toHaveBeenCalledWith({
      kind: 'jump',
      networkId: 2,
      target: 'alice',
      messageId: null,
    });
  });

  it('treats a non-numeric msg as a null messageId, not NaN', () => {
    h.connected.value = true;
    installWindow('?net=1&buf=%23x&msg=foo');
    const onJump = vi.fn<(payload: unknown) => void>();

    consumeColdStartJump(openBuffers, fakeRouter(), onJump);

    expect(onJump).toHaveBeenCalledWith({
      kind: 'jump',
      networkId: 1,
      target: '#x',
      messageId: null,
    });
  });

  it('strips THROUGH the router, not raw history', () => {
    // A raw replaceState updates the address bar while vue-router's own
    // recorded location keeps the consumed ?msg — and that stale location is
    // what lands in history.state.back on the next push, which Settings
    // captures as its return target. "← back" then replayed the jump.
    h.connected.value = true;
    installWindow('?net=1&buf=%23chan&msg=42');
    replaceCalls.length = 0;

    consumeColdStartJump(openBuffers, fakeRouter(), vi.fn<(p: unknown) => void>());

    expect(replaceCalls).toHaveLength(1);
    expect(replaceCalls[0]).not.toHaveProperty('msg');
  });

  it('does nothing and leaves unrelated params when there is no deep link', () => {
    h.connected.value = true;
    installWindow('?foo=bar');
    const onJump = vi.fn<(payload: unknown) => void>();

    consumeColdStartJump(openBuffers, fakeRouter(), onJump);

    expect(onJump).not.toHaveBeenCalled();
    expect(currentSearch()).toBe('?foo=bar');
  });

  it('captures (strips) the intent but defers the jump until ready', () => {
    vi.useFakeTimers();
    let dispose: (() => void) | undefined;
    try {
      h.connected.value = false; // socket not up yet
      installWindow('?net=1&buf=%23chan&msg=42');
      const onJump = vi.fn<(payload: unknown) => void>();

      dispose = consumeColdStartJump(openBuffers, fakeRouter(), onJump);

      // Not fired yet, but the URL is already cleaned so a refresh can't double it.
      expect(onJump).not.toHaveBeenCalled();
      expect(currentSearch()).toBe('');
    } finally {
      // Tear down the deferred watch/timer so it can't leak into other tests.
      dispose?.();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
