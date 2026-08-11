// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { previewsEnabled } from './previews.js';

describe('previewsEnabled', () => {
  const withUrl = (value: string | undefined, run: () => void) => {
    const saved = process.env.LURKER_PREVIEWS_URL;
    if (value === undefined) delete process.env.LURKER_PREVIEWS_URL;
    else process.env.LURKER_PREVIEWS_URL = value;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.LURKER_PREVIEWS_URL;
      else process.env.LURKER_PREVIEWS_URL = saved;
    }
  };

  it('defaults OFF — an upgrade with no decoder configured dials nothing', () => {
    // The whole feature is the decoder: no LURKER_PREVIEWS_URL, no previews. An operator who
    // upgrades and does nothing gets a server that never reaches out. The Lounge ships
    // `prefetch: false` for the same reason.
    withUrl(undefined, () => expect(previewsEnabled()).toBe(false));
    // Present-but-empty (or whitespace) is not "configured" — it's the unset state spelled
    // a different way, which is exactly how a half-written compose file arrives.
    withUrl('', () => expect(previewsEnabled()).toBe(false));
    withUrl('   ', () => expect(previewsEnabled()).toBe(false));
  });

  it('is enabled by a configured decoder URL — the presence IS the gate', () => {
    withUrl('http://lurker-previews:8030', () => expect(previewsEnabled()).toBe(true));
    withUrl('http://127.0.0.1:8030', () => expect(previewsEnabled()).toBe(true));
  });
});
