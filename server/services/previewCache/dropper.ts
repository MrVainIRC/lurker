// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The hosted backend (CP #63). Bytes go to the operator-run dropper service —
// POST /api/previews with the cell-computed key — which writes them under the
// fleet bucket's `previews/` prefix, and browsers read them DIRECTLY from the
// CDN in front of that bucket. The cell holds an upload key and nothing else:
// no bucket credentials, no delete capability, by design. Everything this
// module says about resource bounds is inherited from the s3 backend, whose
// docblocks are the reference; the only genuine difference is the transport
// (a Bearer-keyed multipart POST instead of a SigV4 PUT).
//
// ⚠ The key is the SAME `byteCacheKey` digest every cell computes for a URL, so
// the cache is shared fleet-wide: cell B re-storing what cell A already stored
// is an idempotent overwrite of the same object, not a conflict.
//
// ⚠ Everything the s3 module's header says about WHAT A PUBLIC OBJECT CAN AND
// CANNOT CARRY applies verbatim here — same bucket, same CDN, same three
// replayable headers. The dropper sets Content-Type, Content-Disposition and
// Cache-Control on the object at store time; nosniff and the CSP sandbox are
// not expressible, and the bound on that is the dropper's own image-only,
// magic-byte-verified allowlist.

import fs from 'fs/promises';
import { fileSource } from '../uploadProviders/source.js';
import { postMultipart, type StreamPart } from '../uploadProviders/multipart.js';
import { openTempFile } from './tempFile.js';
import { tryAcquireStoreSlot, warnOnce } from './inflight.js';
import { discard, type S3Read, type S3Writer } from './s3.js';
import type { DropperCacheConfig } from './config.js';

/** Where a reader is sent. Public by construction — that is the point of the
 *  mode. `publicBaseUrl` already contains the dropper's key prefix, and the key
 *  is a hex digest, so no joining logic and no percent-encoding is needed. */
export function publicDropperUrl(cfg: DropperCacheConfig, key: string): string {
  return `${cfg.publicBaseUrl}/${key}`;
}

/**
 * Read one object back through the CDN.
 *
 * ⚠ NOT the common path, same as the s3 backend's read: once an object is
 * stored, the descriptor mints its public URL and clients fetch it without
 * touching the cell. This exists for a client holding a descriptor minted
 * BEFORE the store landed — serve them, and on a genuine 404 repair the row
 * that said the object was there.
 *
 * ⚠⚠ Distinguishes GONE from BROKEN, exactly as `readS3` does: only a genuine
 * 404 may forget an index row. A 403, a timeout or a DNS failure is a miss and
 * nothing more. (One nuance the s3 backend does not have: this GET goes through
 * the CDN, so an edge-cached 404 from just before the store landed can look
 * genuine. The cost is only a redundant re-store, and the window is tiny —
 * descriptors mint only after the row exists.)
 */
export async function readDropper(
  cfg: DropperCacheConfig,
  key: string,
  maxBytes: number,
): Promise<S3Read> {
  try {
    const res = await fetch(publicDropperUrl(cfg, key), {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      await discard(res);
      return { kind: 'missing' };
    }
    if (!res.ok) {
      await discard(res);
      return { kind: 'error' };
    }
    // ⚠⚠ Bounded before reading, not after — and an ABSENT length is declined,
    // not waved through. `Number(null)` is 0, which is finite and under any cap,
    // so a plain isFinite test passes exactly the responses it cannot bound.
    // Same guard, same reasoning as `readS3`.
    const raw = res.headers.get('content-length');
    const declared = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(declared) || declared > maxBytes) {
      await discard(res);
      return { kind: 'error' };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) return { kind: 'error' };
    return {
      kind: 'ok',
      body,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Begin storing an object whose bytes are still arriving.
 *
 * ⚠⚠ STAGED TO A FILE, never collected in memory — `postMultipart` computes an
 * exact Content-Length from the staged file's size, which is what lets the POST
 * go out as a plain framed request instead of buffering in the heap. The route
 * deliberately does not await `commit`, so the send runs OUTSIDE the mediaPool
 * slots for up to the multipart module's 60 s timeout — which is why the shared
 * in-flight ceiling (./inflight.ts) bounds it, exactly as it bounds the s3 PUT.
 */
export async function openDropperWrite(
  cfg: DropperCacheConfig,
  key: string,
): Promise<S3Writer | null> {
  const settle = tryAcquireStoreSlot();
  if (!settle) return null;

  const staged = await openTempFile(cfg.stagingDir, key);
  if (!staged) {
    settle();
    return null;
  }

  return {
    write(chunk: Buffer): void {
      staged.write(chunk);
    },
    async commit(contentType: string): Promise<boolean> {
      if (!(await staged.close())) {
        settle();
        return false;
      }
      try {
        const { size } = await fs.stat(staged.path);
        const source = fileSource(staged.path, size);
        const parts: StreamPart[] = [
          // ⚠ The text part goes BEFORE the file part, so the dropper's multipart
          // parser has the key in req.body by the time the file lands — the same
          // ordering rule the upload driver documents.
          { name: 'key', value: key },
          { name: 'file', filename: key, contentType, source },
        ];
        const resp = await postMultipart(`${cfg.url}/api/previews`, parts, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (resp.status >= 200 && resp.status < 300) return true;
        warnOnce(`dropper refused a store: ${resp.status} ${resp.text.slice(0, 200)}`);
        return false;
      } catch (err) {
        warnOnce(`dropper store failed: ${(err as Error)?.message ?? err}`);
        return false;
      } finally {
        // ⚠ ALWAYS, on every exit. The staging file is ours and nothing else
        // knows it exists — not the index, not eviction — so a leak here is
        // bytes on the volume that no later pass can find.
        await fs.unlink(staged.path).catch(() => {});
        settle();
      }
    },
    async abort(): Promise<void> {
      await staged.discard();
      settle();
    },
  };
}
