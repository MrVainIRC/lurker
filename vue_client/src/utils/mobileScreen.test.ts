// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { screenForRoute } from './mobileScreen.js';

describe('screenForRoute', () => {
  it.each([
    ['at /', undefined, false, true, 'list'],
    ['on a buffer', '7', false, true, 'buffer'],
    ['on its members list', '7', true, true, 'members'],
  ])('%s', (_label, id, isMembers, active, expected) => {
    expect(screenForRoute(id, isMembers as boolean, active as boolean)).toBe(expected);
  });

  it('holds on the list while a routed buffer is still resolving', () => {
    // Cold launch from a bookmark or a notification: the route names a buffer
    // several seconds before the WS delivers it. Showing the buffer screen with
    // nothing in it looks like a broken app.
    expect(screenForRoute('7', false, false)).toBe('list');
    expect(screenForRoute('7', true, false)).toBe('list');
  });

  it('falls back to the list when the active buffer goes away', () => {
    // Closing the buffer (or removing its network) nulls activeKey. Stranding
    // the user on an empty buffer or a members list for a buffer that no longer
    // exists is the #137 bug.
    expect(screenForRoute('7', true, false)).toBe('list');
  });
});
