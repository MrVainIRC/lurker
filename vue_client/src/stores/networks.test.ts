// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { canDisconnect } from './networks.js';

// The predicate behind every "Disconnect ⟷ Reconnect" control (the network context
// menu and both chat views' server-buffer headers). It is one function precisely so
// those three can't drift back apart.
describe('canDisconnect — which action a network state needs', () => {
  it('offers Disconnect while a network is on the wire', () => {
    expect(canDisconnect('connected')).toBe(true);
  });

  // ⚠⚠ The whole of #785. The retry ladder is unbounded, and it keeps its
  // IrcConnection for the entire outage — so a network pinned against a dead server
  // sits in 'reconnecting' indefinitely. Testing for 'connected' left Reconnect as
  // the only offered action, and Reconnect routes through restartNetwork: it tears
  // the connection down and starts a FRESH loop. There was no reachable stop.
  it('offers Disconnect during a reconnect backoff, which is what stops the loop', () => {
    expect(canDisconnect('reconnecting')).toBe(true);
  });

  it('offers Disconnect during a connect, which can hang on a handshake', () => {
    expect(canDisconnect('connecting')).toBe(true);
  });

  it('offers Reconnect once the network is actually down', () => {
    expect(canDisconnect('disconnected')).toBe(false);
  });

  // A network we have never heard a state for reads as "connect it", not "stop it".
  it('offers Reconnect for an unknown state', () => {
    expect(canDisconnect(undefined)).toBe(false);
    expect(canDisconnect(null)).toBe(false);
    expect(canDisconnect('')).toBe(false);
  });
});
