// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The poster path end to end: a decoder hands back a first frame during resolve,
// the cell stores it in the byte cache, mints a `thumb` for the video card, and
// serves it from the dedicated route — the one byte URL in the system with no
// origin behind it, which is why every miss is an honest 404 rather than a
// re-fetch nothing could perform.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';

const ctx = setupTestDb('routes-link-preview-poster');
process.env.LURKER_LINK_PREVIEWS = 'on';
process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'poster-cache');

let stub: StubDecoder;
let app: Express;
let agent: LurkerTestAgent;
let jpeg: Buffer;

beforeAll(async () => {
  stub = await startStubDecoder();
  const { createUser } = await import('../db/users.js');
  const router = (await import('./linkPreview.js')).default;
  const alice = createUser('alice-poster');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);
  // A real JPEG, because the byte cache's signature check is part of the path under test.
  jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#246' } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await stub.close();
  delete process.env.LURKER_PREVIEW_CACHE_MODE;
  delete process.env.LURKER_PREVIEW_CACHE_DIR;
  ctx.cleanup();
});

beforeEach(() => {
  stub.resolveAsks.length = 0;
});

async function resolveOne(url: string): Promise<Record<string, unknown>> {
  const res = await agent
    .post('/api/link-preview/resolve')
    .send({ urls: [url] })
    .expect(200);
  return res.body.previews[0] as Record<string, unknown>;
}

describe('a video card with a poster', () => {
  it('stores the frame, mints a thumb, and serves it back hardened', async () => {
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'video', imageUrl: 'https://cdn.example.com/clip.mp4', mime: 'video/mp4' },
      poster: { jpeg, width: 32, height: 18 },
    });

    const preview = await resolveOne('https://cdn.example.com/clip.mp4');
    expect(preview.kind).toBe('video');
    // The poster rides the byte cache being available, and the cell said so when it asked.
    expect(stub.resolveAsks[0]?.wantPoster).toBe(true);
    // A thumb, never a src — the poster is card decoration; the clip is still not relayed.
    expect(preview.src).toBeUndefined();
    expect(String(preview.thumb)).toMatch(/^\/api\/link-preview\/poster\/[a-f0-9]{64}$/);
    // The box the client reserves is the POSTER's shape.
    expect(preview.thumbWidth).toBe(32);
    expect(preview.thumbHeight).toBe(18);

    const served = await agent.get(String(preview.thumb)).expect(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(served.headers['cache-control']).toBe('private, max-age=86400, immutable');
    expect(Buffer.from(served.body).equals(jpeg)).toBe(true);
  });

  it('refuses a poster that is not actually a JPEG, and the card just has no poster', async () => {
    // ⚠⚠ The trust boundary, exercised: the decoder is the box built to be compromised
    // first, so its "poster" is a CLAIM until the byte cache's signature check reads the
    // magic bytes. A decoder handing back HTML-in-a-poster must get nothing under the
    // cell's origin — and the failure must be a posterless card, never a failed resolve.
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'video', imageUrl: 'https://cdn.example.com/evil.mp4', mime: 'video/mp4' },
      poster: { jpeg: Buffer.from('<script>alert(1)</script>'), width: 32, height: 18 },
    });

    const preview = await resolveOne('https://cdn.example.com/evil.mp4');
    expect(preview.kind).toBe('video');
    expect(preview.status).toBe('ok');
    expect(preview.thumb).toBeUndefined();
    expect(preview.thumbWidth).toBeUndefined();
  });

  it('404s a poster key that was never stored, and one that is not a key at all', async () => {
    const missing = await agent.get(`/api/link-preview/poster/${'e'.repeat(64)}`);
    expect(missing.status).toBe(404);
    // Not key-shaped: answered without a cache probe, so the route is not an existence
    // oracle over arbitrary strings.
    const notAKey = await agent.get('/api/link-preview/poster/not-a-key');
    expect(notAKey.status).toBe(404);
    const wrongCase = await agent.get(`/api/link-preview/poster/${'E'.repeat(64)}`);
    expect(wrongCase.status).toBe(404);
  });

  it('keeps audio symmetrical: cover art becomes the thumb, bytes stay unrelayed', async () => {
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'audio', imageUrl: 'https://cdn.example.com/song.mp3', mime: 'audio/mpeg' },
      poster: { jpeg, width: 32, height: 18 },
    });
    const preview = await resolveOne('https://cdn.example.com/song.mp3');
    expect(preview.kind).toBe('audio');
    expect(preview.src).toBeUndefined();
    expect(String(preview.thumb)).toMatch(/^\/api\/link-preview\/poster\//);
  });
});
