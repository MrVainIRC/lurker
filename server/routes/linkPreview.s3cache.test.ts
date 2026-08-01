// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `s3` byte cache through the ROUTE, against a stub bucket that remembers
// what it was sent.
//
// ⚠⚠ THIS FILE IS THE PRICE OF ADMISSION FOR THE MODE. `s3` was built once
// before, bundled with `local`, and split back out because a review found that
// nearly every serious defect lived in the bucket half — the half with no
// route-level coverage. Bundled, the untested half hid behind the tested one, and
// its first real execution would have been against somebody's live R2.
//
// ⚠ What's mocked is the POLICY and the far end, never the mechanism: the address
// guard is inverted so a loopback origin is reachable, and the bucket is a stand-in
// http server. The SigV4 signing, the key layout, the staging file, the streamed
// PUT, the index write, the descriptor mint, Express, the token, the throttles, the
// pool and safeRequest are all shipping code.
//
// ⚠ The signature is asserted as a SCHEME, not recomputed. Reimplementing the
// calculation here would only test the test.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const ctx = setupTestDb('routes-link-preview-s3cache');

/** What the stub bucket recorded for one request. */
interface Put {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let puts: Put[] = [];
/** Objects the stub bucket is holding, by request path. */
let objects = new Map<string, { body: Buffer; contentType: string }>();
/** Flip to make every write fail, without changing anything else. */
let bucketRejects = false;

let bucket: http.Server;
let bucketBase: string;

const BUCKET_NAME = 'previews-bucket';
const PREFIX = 'previews';
const CDN = 'https://cdn.example.com';

let app: Express;
let agent: LurkerTestAgent;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;
let countCached: typeof import('../db/previewCache.js').countCached;
let whenStoresSettle: typeof import('../services/previewCache/index.js').whenStoresSettle;
let byteCacheKey: typeof import('../services/previewCache/index.js').byteCacheKey;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let base: string;
let originHits = 0;

const tokenFor = (p: string): string => mintProxyToken(`${base}${p}`);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function servePng(body = PNG): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
    res.end(body);
  };
}

beforeAll(async () => {
  // The stub bucket. Started BEFORE the cache config is read, because the config
  // is resolved once per process and has to point at a real port.
  bucket = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      puts.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      if (req.method === 'PUT') {
        if (bucketRejects) {
          res.writeHead(403).end('denied');
          return;
        }
        objects.set(req.url || '', {
          body,
          contentType: String(req.headers['content-type'] || ''),
        });
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET') {
        const held = objects.get(req.url || '');
        if (!held) {
          res.writeHead(404).end('no such key');
          return;
        }
        res.writeHead(200, {
          'content-type': held.contentType,
          'content-length': String(held.body.length),
        });
        res.end(held.body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(req.url || '');
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve));
  bucketBase = `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`;

  process.env.LURKER_LINK_PREVIEWS = 'on';
  process.env.LURKER_PREVIEW_CACHE_MODE = 's3';
  process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = bucketBase;
  process.env.LURKER_PREVIEW_CACHE_S3_BUCKET = BUCKET_NAME;
  process.env.LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID = 'test-key-id';
  process.env.LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY = 'test-secret';
  process.env.LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL = CDN;
  process.env.LURKER_PREVIEW_CACHE_S3_PREFIX = PREFIX;
  process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'preview-staging');

  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  ({ countCached } = await import('../db/previewCache.js'));
  ({ whenStoresSettle, byteCacheKey } = await import('../services/previewCache/index.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-s3cache');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);

  origin = http.createServer((req, res) => {
    originHits++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(origin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  await new Promise<void>((resolve) => bucket.close(() => resolve()));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('LURKER_PREVIEW_CACHE')) delete process.env[k];
  }
  ctx.cleanup();
});

beforeEach(async () => {
  // ⚠⚠ Drains BEFORE clearing, for the same reason the `local` suite does: stores
  // are fire-and-forget, so a write from the previous test can still be in flight
  // and land in this one's clean state, reading as "this test cached something".
  await whenStoresSettle();
  originHits = 0;
  puts = [];
  objects = new Map();
  bucketRejects = false;
  const { default: db } = await import('../db/index.js');
  db.prepare('DELETE FROM preview_cache').run();
});

/** The request path the stub bucket should have seen for one origin URL. */
const keyPathFor = (originPath: string): string =>
  `/${BUCKET_NAME}/${PREFIX}/${byteCacheKey(`${base}${originPath}`)}`;

describe('the s3 byte cache, end to end', () => {
  it('PUTs the object to <bucket>/<prefix>/<key>, signed, and records it', async () => {
    servePng();
    const first = await agent.get(`/api/link-preview/media/${tokenFor('/stored.png')}`);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).equals(PNG)).toBe(true);
    await whenStoresSettle();

    expect(puts).toHaveLength(1);
    const put = puts[0]!;
    // ⚠ The METHOD is asserted. The pre-split suite never did, so changing PUT to
    // POST passed all five of its tests — a stub that records everything cannot
    // tell you it was written to wrongly unless you ask.
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(keyPathFor('/stored.png'));
    expect(put.body.equals(PNG)).toBe(true);
    expect(String(put.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key-id\//);
    expect(put.headers['content-type']).toBe('image/png');
    expect(countCached()).toBe(1);
  });

  it('stores the hardening headers object storage can actually replay', async () => {
    // ⚠⚠ A cached object is fetched DIRECTLY by the browser, so the only headers
    // it ever sees are the ones signed onto the object here — `applyMediaHeaders`
    // never runs for that request. Of the six the proxy sets, object storage will
    // store and replay exactly these; the other three are unavailable by
    // construction and are accounted for in previewCache/s3.ts.
    servePng();
    await agent.get(`/api/link-preview/media/${tokenFor('/headers.png')}`);
    await whenStoresSettle();

    const put = puts[0]!;
    expect(put.headers['content-disposition']).toBe('inline');
    // ⚠ NOT the uploader's `public, max-age=31536000, immutable`. A URL-keyed cache
    // legitimately points at different bytes over time, and a year at the edge would
    // mean deleting an object could not un-serve it — the signer hardcoded that
    // value until this mode needed otherwise.
    expect(put.headers['cache-control']).toBe('public, max-age=86400');
    expect(put.headers['cache-control']).not.toMatch(/immutable/);
  });

  it('mints the CDN URL in the descriptor once the object is stored', async () => {
    // ⚠⚠ THE HEADLINE PROPERTY OF THE MODE, and the reason there is no redirect
    // anywhere in it. A client is handed the public URL at DESCRIPTOR-MINT time, so
    // a cached image costs the cell nothing at all — no bytes, and not even the
    // round trip a 302 would have spent to say so.
    servePng();
    const imageUrl = `${base}/minted.png`;

    // Before anything is cached, the descriptor points at the proxy — which is what
    // makes the first read possible at all.
    const cold = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(cold.status).toBe(200);
    expect(cold.body.previews[0].src).toMatch(/^\/api\/link-preview\/media\//);

    // Populate the cache the only way it is ever populated: a real read through the
    // proxy.
    await agent.get(`/api/link-preview/media/${mintProxyToken(imageUrl)}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    const warm = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(warm.status).toBe(200);
    expect(warm.body.previews[0].src).toBe(`${CDN}/${PREFIX}/${byteCacheKey(imageUrl)}`);
  });

  it('leaves NO ROW when the bucket refuses the write', async () => {
    // ⚠⚠ The guard worth having, and the one that turns a cache miss into a
    // permanently broken image. An index entry for an object that does not exist
    // makes `publicByteUrl` mint a public URL that 404s — for everyone, with no
    // request reaching the cell to notice, for as long as the row lives.
    // Revert-proven: deleting the status check in openS3Write takes this red.
    bucketRejects = true;
    servePng();
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/denied.png')}`);
    // ⚠ The READER is still served. A cache is an optimisation over a feature that
    // already works, so a bucket failure must never reach the person asking.
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
    await whenStoresSettle();

    expect(puts.some((p) => p.method === 'PUT')).toBe(true);
    expect(countCached()).toBe(0);
  });

  it('leaves no staging file behind, whether the write lands or fails', async () => {
    // ⚠ The staging file is invisible to the index and to eviction, so a leak here
    // is bytes on the volume nothing can find — and unlike `local`'s temp files it
    // has no shard directory anyone would think to look in.
    const stagingDir = process.env.LURKER_PREVIEW_CACHE_DIR!;
    servePng();
    await agent.get(`/api/link-preview/media/${tokenFor('/kept.png')}`);
    await whenStoresSettle();

    bucketRejects = true;
    await agent.get(`/api/link-preview/media/${tokenFor('/dropped.png')}`);
    await whenStoresSettle();

    const stray = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
    expect(stray).toEqual([]);
  });

  it('serves a proxy request for a stored object from the BUCKET, not the origin', async () => {
    // A client holding a descriptor minted before the store landed still arrives at
    // the proxy. That read should cost a bucket GET, not another third-party fetch.
    servePng();
    const token = tokenFor('/reread.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(originHits).toBe(1);

    const second = await agent.get(`/api/link-preview/media/${token}`);
    expect(second.status).toBe(200);
    expect(Buffer.from(second.body).equals(PNG)).toBe(true);
    // ⚠ THE assertion. Same bytes proves nothing on its own — the uncached path
    // returns those too. One origin hit for two reads is the feature.
    expect(originHits).toBe(1);
    expect(puts.some((p) => p.method === 'GET')).toBe(true);
  });

  it('repairs the row and re-fetches when the object has been deleted from the bucket', async () => {
    // ⚠⚠ Finding 1, in the one place it can still be caught. A 30-day lifecycle rule
    // deletes objects the cell does not run and cannot observe; the age bound is the
    // primary defence, but a proxy read is the only moment we ever learn an object
    // has gone early. A 404 must forget the row rather than 404 forever.
    servePng();
    const token = tokenFor('/vanished.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    objects.clear(); // the lifecycle rule, or a human with the console open

    // ⚠⚠ The origin is taken away too, and that is what makes this test BITE. With
    // the origin still healthy the row is rewritten by the re-store on the way out,
    // so "the row was forgotten" and "the row was never forgotten" look identical
    // from here — the first draft of this test passed with the 404 branch reporting
    // a plain error, which is precisely the bug it is supposed to catch. Denying the
    // re-store leaves the forget as the only thing that could have emptied the table.
    handler = (_req, res) => res.writeHead(404).end();

    const after = await agent.get(`/api/link-preview/media/${token}`);
    expect(after.status).toBe(404);
    expect(originHits).toBe(2);
    await whenStoresSettle();
    expect(countCached()).toBe(0);

    // ...and with a working origin it heals completely.
    servePng();
    const healed = await agent.get(`/api/link-preview/media/${token}`);
    expect(healed.status).toBe(200);
    expect(Buffer.from(healed.body).equals(PNG)).toBe(true);
    await whenStoresSettle();
    expect(countCached()).toBe(1);
  });

  it('does not mint a CDN URL for a row past its age bound', async () => {
    // ⚠⚠ The primary defence for finding 1, and the only one that works without a
    // request reaching us. Objects are deleted by a 30-day bucket lifecycle rule the
    // cell does not run and cannot observe, so a row that outlived its object would
    // have the descriptor handing every user a public URL that 404s — with nothing
    // arriving at the cell to notice. Seven days against thirty is the margin that
    // makes the row provably the shorter-lived of the two.
    servePng();
    const imageUrl = `${base}/ageing.png`;
    await agent.get(`/api/link-preview/media/${mintProxyToken(imageUrl)}`);
    await whenStoresSettle();

    const warm = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(warm.body.previews[0].src).toBe(`${CDN}/${PREFIX}/${byteCacheKey(imageUrl)}`);

    // Age the row past the bound. Eight days: the bound is seven.
    const { default: db } = await import('../db/index.js');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE preview_cache SET created_at = ?').run(old);

    const stale = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    // ⚠ Back to the PROXY, not to a broken CDN URL. Falling back is always safe;
    // minting for an object that may be gone is the one thing that cannot self-heal.
    expect(stale.body.previews[0].src).toMatch(/^\/api\/link-preview\/media\//);
  });

  it('stays a miss, not an error, when the bucket is unreachable', async () => {
    // A cache is an optimisation over a feature that already works, so an
    // unreachable bucket has to degrade to the uncached path rather than to a 500.
    const { resetCacheConfigForTests } = await import('../services/previewCache/index.js');
    const realEndpoint = process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT!;
    // A port nothing is listening on. Reserved-but-closed beats a bogus host, which
    // would test DNS failure instead.
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = `http://127.0.0.1:${deadPort}`;
    resetCacheConfigForTests();
    try {
      servePng();
      const res = await agent.get(`/api/link-preview/media/${tokenFor('/nobucket.png')}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(PNG)).toBe(true);
      await whenStoresSettle();
      expect(countCached()).toBe(0);
    } finally {
      process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = realEndpoint;
      resetCacheConfigForTests();
    }
  });

  it('does not cache a video, and mints no CDN URL for one', async () => {
    const MP4 = Buffer.alloc(2048, 7);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) });
      res.end(MP4);
    };
    const token = tokenFor('/clip.mp4');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(0);
    expect(puts.some((p) => p.method === 'PUT')).toBe(false);
  });
});
