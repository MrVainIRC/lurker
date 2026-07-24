// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The store's half of the login-loop fix: it owns the one and only signal that
// re-arms api.ts's stale-session bounce — a session that demonstrably exists.
// Mock the api module so this exercises that decision without a network.
const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: unknown) => Promise<any>>(),
  clearAuthRecoveryGuard: vi.fn<() => void>(),
}));

vi.mock('../api.js', () => ({
  api: h.api,
  clearAuthRecoveryGuard: h.clearAuthRecoveryGuard,
}));
vi.mock('../composables/useSessionReset.js', () => ({ resetSession: vi.fn<() => void>() }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn<() => Promise<unknown>>(),
  startAuthentication: vi.fn<() => Promise<unknown>>(),
}));

const { useAuthStore } = await import('./auth.js');

const USER = { id: 1, username: 'brad', role: 'user' as const };

describe('auth store — stale-session guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
    h.clearAuthRecoveryGuard.mockReset();
  });

  it('re-arms the bounce only when /api/auth/me returns a user', async () => {
    h.api.mockResolvedValue({ user: USER });
    await useAuthStore().fetchMe();
    expect(h.clearAuthRecoveryGuard).toHaveBeenCalledTimes(1);
  });

  it('leaves the bounce disarmed when the session is dead', async () => {
    // The loop case: a logged-out load must not re-arm, or the next 401 bounces
    // again and the tab reloads forever.
    h.api.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const auth = useAuthStore();
    await auth.fetchMe();
    expect(auth.user).toBeNull();
    expect(auth.checked).toBe(true);
    expect(h.clearAuthRecoveryGuard).not.toHaveBeenCalled();
  });

  it('re-arms on a fresh sign-in, so a later session loss still recovers', async () => {
    h.api.mockResolvedValue({ user: USER });
    await useAuthStore().loginWithPassword({ username: 'brad', password: 'hunter22' });
    expect(h.clearAuthRecoveryGuard).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent fetchMe callers into one request', async () => {
    // The router guard and App.vue's boot both fire on a fresh load; two
    // /api/auth/me calls double this tab's spend against the auth rate limiter.
    h.api.mockResolvedValue({ user: USER });
    const auth = useAuthStore();
    const [a, b] = await Promise.all([auth.fetchMe(), auth.fetchMe()]);
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(a).toEqual(USER);
    expect(b).toEqual(USER);
  });

  it('does not latch the in-flight promise after it settles', async () => {
    h.api.mockResolvedValue({ user: USER });
    const auth = useAuthStore();
    await auth.fetchMe();
    await auth.fetchMe();
    expect(h.api).toHaveBeenCalledTimes(2);
  });
});
