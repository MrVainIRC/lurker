// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Express app construction, split out from server.ts so the route wiring can be
// built and exercised in isolation (integration tests) without booting the HTTP
// server, WebSocket hub, or IRC manager. server.ts owns the process lifecycle;
// this module owns "what routes exist and how requests are handled" — including
// the edition-aware gating of operator-only surfaces.

import express from 'express';
import type { Express, ErrorRequestHandler } from 'express';
import { Router } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';

import authRouter from './routes/auth.js';
import networksRouter from './routes/networks.js';
import networkPresetsRouter from './routes/networkPresets.js';
import settingsRouter from './routes/settings.js';
import highlightRulesRouter from './routes/highlightRules.js';
import highlightsRouter from './routes/highlights.js';
import bookmarksRouter from './routes/bookmarks.js';
import searchRouter from './routes/search.js';
import themesRouter from './routes/themes.js';
import pushRouter from './routes/push.js';
import adminRouter from './routes/admin.js';
import uploadsRouter from './routes/uploads.js';
import uploadersRouter from './routes/uploaders.js';
import localUploadsRouter from './routes/localUploads.js';
import dccRouter from './routes/dcc.js';
import draftsRouter from './routes/drafts.js';
import { exportsRouter, importRouter } from './routes/exports.js';
import apiTokensRouter from './routes/apiTokens.js';
import configRouter from './routes/config.js';
import linkPreviewRouter from './routes/linkPreview.js';
import nodeRouter from './routes/node.js';
import mcpRouter from './services/mcpServer.js';
import { requireApiAuth } from './middleware/apiAuth.js';
import { isNodeMode } from './utils/edition.js';
import { previewsEnabled } from './utils/previews.js';
import { allowedBrowserOrigins } from './utils/corsOrigins.js';
import { basePath, publicBasePath } from './utils/basePath.js';

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  console.error('[lurker] error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
};

/**
 * Build the fully-wired Express app. `sessionSecret` keys cookie-parser for the
 * signed `lurker_session` cookie (the same secret server.ts hands to the WS
 * hub). Route gating reads the cached edition, so set LURKER_EDITION before the
 * first getEdition() call.
 */
export function buildApp(sessionSecret: string): Express {
  const app = express();
  const apiRouter = Router();
  const base = publicBasePath();

  // CORS_ORIGIN is a comma-separated allowlist, normalized to URL origins (see
  // utils/corsOrigins). The WS upgrade origin check reads the same source, so the
  // HTTP and WebSocket layers agree exactly on what's allowed.
  const corsOrigins = allowedBrowserOrigins();
  // A set-but-unparseable CORS_ORIGIN (e.g. a bare host with no scheme) normalizes
  // to nothing, silently rejecting every cross-origin request. Surface it once at
  // startup rather than leaving the operator to debug a mystery 403/CORS failure.
  if (process.env.CORS_ORIGIN && corsOrigins.length === 0) {
    console.warn(
      `[lurker] CORS_ORIGIN is set ("${process.env.CORS_ORIGIN}") but no valid origin parsed from it — cross-origin requests will be rejected. Each entry needs a scheme, e.g. https://irc.example.com`,
    );
  }
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(sessionSecret));

  apiRouter.use('/auth', authRouter);
  apiRouter.use('/networks', networksRouter);
  apiRouter.use('/network-presets', networkPresetsRouter);
  apiRouter.use('/settings', settingsRouter);
  apiRouter.use('/highlight-rules', highlightRulesRouter);
  apiRouter.use('/highlights', highlightsRouter);
  apiRouter.use('/bookmarks', bookmarksRouter);
  apiRouter.use('/search', searchRouter);
  apiRouter.use('/themes', themesRouter);
  apiRouter.use('/push', pushRouter);
  apiRouter.use('/admin', adminRouter);
  apiRouter.use('/uploads', uploadsRouter);
  apiRouter.use('/uploaders', uploadersRouter);
  // Public (no-auth) serving of local-driver files. Off /api by design: the URL
  // is opened by anyone the uploader shares it with, protected only by its
  // non-guessable key. Mounted before the SPA fallback so it wins the route.
  // Self-host only — the `local` driver isn't offered on the (ephemeral) hosted
  // fleet, so the route would only ever 404 there; don't expose it at all.
  if (!isNodeMode()) {
    // /uploads/local was the original mount (#582 dropped the redundant segment).
    // It stays mounted forever as an alias: upload_history.url stores the fully
    // absolutized link and nothing reparses it, so every link already pasted into
    // IRC — including ones read by other clients we can't rewrite — still resolves.
    // The two-segment path can't match the new mount's single-segment '/:key', so
    // order between them doesn't matter.
    app.use(basePath('/uploads/local'), localUploadsRouter);
    app.use(basePath('/uploads'), localUploadsRouter);
  }
  apiRouter.use('/dcc', dccRouter);
  apiRouter.use('/drafts', draftsRouter);
  apiRouter.use('/exports', exportsRouter);
  apiRouter.use('/imports', importRouter);
  apiRouter.use('/config', configRouter);
  // ⚠ Not mounted at all when the feature is off, so both endpoints 404 rather than existing
  // and refusing. The in-route and resolver guards stay as defence in depth — this is the outer
  // one, and it's what makes "off" mean the surface isn't there.
  if (previewsEnabled()) {
    apiRouter.use('/link-preview', linkPreviewRouter);
  }

  apiRouter.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });
  app.use(basePath('/api'), apiRouter);

  // The HTTP API-token feature and the MCP server are the two ends of the same
  // bearer-token model: /api/api-tokens (session-cookie auth) mints the tokens,
  // and /mcp (bearer auth) consumes them. The hosted service routes a customer
  // to their cell by the cp_session cookie, but a bearer client carries no such
  // cookie — so /mcp can't be addressed through the per-cell proxy, which makes
  // the tokens unusable there. Disable both in node edition (A7); A3 hides the
  // matching UI. Standalone keeps them fully featured.
  if (!isNodeMode()) {
    apiRouter.use('/api-tokens', apiTokensRouter);
    app.use(basePath('/mcp'), requireApiAuth, mcpRouter);
  }

  // Orchestrator-only control surface. Mounted exclusively in node edition so a
  // standalone self-hosted instance never exposes it at all.
  if (isNodeMode()) {
    apiRouter.use('/node', nodeRouter);
  }

  // SPA fallback for client-side routes. `mcp` joins `api`/`ws` in the exclusion
  // so that in node edition — where /mcp isn't mounted — a stray GET /mcp 404s
  // instead of being served index.html; it's a disabled endpoint, not a page.
  // (In standalone the mounted /mcp middleware handles it before this anyway.)
  //
  // `assets` is excluded for a different reason: everything under it is a real
  // hashed build artifact served by express.static above, never a client route.
  // Without the exclusion a missing chunk falls through to here and gets
  // index.html back with a 200 and Content-Type: text/html, so the browser
  // reports a confusing module-type refusal instead of a plain 404 — and the
  // client can't cleanly tell "chunk is gone" from "page is fine" (#571).
  const clientDist = path.join(import.meta.dirname, '../vue_client/dist');
  app.use(basePath('/'), express.static(clientDist));
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fallbackPattern = base
    ? new RegExp(`^${escapedBase}/(?!api(?:/|$)|ws(?:/|$)|mcp(?:/|$)|assets(?:/|$)).*`)
    : /^\/(?!api(?:\/|$)|ws(?:\/|$)|mcp(?:\/|$)|assets(?:\/|$)).*/;
  app.get(fallbackPattern, (_req, res, next) => {
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);

  return app;
}
