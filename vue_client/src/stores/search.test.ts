// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The modal's typing debounce calls runSearch on every input pause, including
// pauses that don't change the effective query — a trailing space, or an
// incomplete `from:` token that's still sitting in the free text. These pin
// the dedupe: an identical effective query keeps the standing results and
// dispatches nothing; a changed one dispatches exactly once.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const socketSend = vi.fn<(payload: Record<string, unknown>) => boolean>();
vi.mock('../composables/useSocket.js', () => ({
  socketSend: (payload: Record<string, unknown>) => socketSend(payload),
}));

const { useSearchStore } = await import('./search.js');

beforeEach(() => {
  setActivePinia(createPinia());
  socketSend.mockReset();
  socketSend.mockReturnValue(true);
});

function reply(store: ReturnType<typeof useSearchStore>, results: unknown[] = []) {
  store.applyResult({ token: store.token, results, hasMore: false });
}

describe('runSearch dedupe', () => {
  it('skips a re-dispatch when the effective query is unchanged', () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos fart');
    store.runSearch();
    expect(socketSend).toHaveBeenCalledTimes(1);
    reply(store, [{ id: 3 }]);

    // Trailing space parses to the same payload — keep the results, no send.
    store.setQuery('from:amiantos fart ');
    store.runSearch();
    expect(socketSend).toHaveBeenCalledTimes(1);
    expect(store.results).toEqual([{ id: 3 }]);
    expect(store.loading).toBe(false);
  });

  it('dispatches again when the effective query changes', () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos far');
    store.runSearch();
    reply(store);
    store.setQuery('from:amiantos fart');
    store.runSearch();
    expect(socketSend).toHaveBeenCalledTimes(2);
    // Each dispatch carries the token applyResult will be matched against.
    expect(socketSend.mock.calls[1][0].token).toBe(store.token);
  });

  it('retries an identical query after a failed dispatch', () => {
    const store = useSearchStore();
    socketSend.mockReturnValueOnce(false); // not connected
    store.setQuery('from:amiantos');
    store.runSearch();
    expect(store.error).toBe('not connected');

    store.runSearch();
    expect(socketSend).toHaveBeenCalledTimes(2);
    expect(store.error).toBe('');
  });

  it('re-dispatches a query retyped after clearing to empty', () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos');
    store.runSearch();
    reply(store, [{ id: 1 }]);

    store.setQuery('');
    store.runSearch(); // nothing to search — clears the session
    expect(store.searched).toBe(false);
    expect(store.results).toEqual([]);

    store.setQuery('from:amiantos');
    store.runSearch();
    expect(socketSend).toHaveBeenCalledTimes(2);
  });

  it('reset clears the dedupe key', () => {
    const store = useSearchStore();
    store.setQuery('hello');
    store.runSearch();
    reply(store);
    store.reset();
    store.setQuery('hello');
    store.runSearch();
    expect(socketSend).toHaveBeenCalledTimes(2);
  });
});
