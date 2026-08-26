// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { apiPath, assetPath, normalizeBasePath, webSocketPath, withBasePath } from './basePath.js';

describe('base path helpers', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['/', ''],
    ['lurker', '/lurker'],
    ['/lurker', '/lurker'],
    ['/lurker/', '/lurker'],
    ['irc/web/', '/irc/web'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it('prefixes application paths without duplicate slashes or duplicate bases', () => {
    expect(withBasePath('/api/me', '/abc')).toBe('/abc/api/me');
    expect(withBasePath('/abc/api/me', '/abc')).toBe('/abc/api/me');
    expect(withBasePath('/', '/abc')).toBe('/abc/');
    expect(withBasePath('/api/me?q=1', '/abc')).toBe('/abc/api/me?q=1');
    expect(withBasePath('https://example.org/api/me', '/abc')).toBe('https://example.org/api/me');
  });

  it('provides specialized paths', () => {
    expect(apiPath('/health', '/irc/web')).toBe('/irc/web/api/health');
    expect(webSocketPath('/irc/web')).toBe('/irc/web/ws');
    expect(assetPath('assets/app.js', '/irc/web')).toBe('/irc/web/assets/app.js');
  });
});
