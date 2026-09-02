// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { avatarUrlForMetadata } from './ircMetadata.js';

const rows = (target: string, value: string) => ({
  [target]: [{ key: 'avatar', value, visibility: '*' }],
});

describe('avatarUrlForMetadata', () => {
  it('prefers stable self metadata and expands the size placeholder', () => {
    expect(
      avatarUrlForMetadata(
        {
          ...rows('*', 'https://cdn.example.test/{size}/self.png'),
          ...rows('Alice', 'https://cdn.example.test/alice.png'),
        },
        'Alice',
        'alice',
      ),
    ).toBe('https://cdn.example.test/64/self.png');
  });

  it('matches peer metadata case-insensitively', () => {
    expect(
      avatarUrlForMetadata(rows('Alice', 'https://cdn.example.test/alice.png'), 'alice', null),
    ).toBe('https://cdn.example.test/alice.png');
  });

  it('rejects non-HTTPS or invalid avatar values', () => {
    expect(
      avatarUrlForMetadata(rows('Alice', 'http://cdn.example.test/alice.png'), 'Alice', null),
    ).toBe(null);
    expect(avatarUrlForMetadata(rows('Alice', 'not a URL'), 'Alice', null)).toBe(null);
  });
});
