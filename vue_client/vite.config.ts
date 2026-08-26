// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import mkcert from 'vite-plugin-mkcert';
import { normalizeBasePath, withBasePath } from '../shared/basePath.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig(({ mode }) => {
  // The client is invoked through `npm run ... --prefix vue_client`, while the
  // documented .env file lives at the repository root. Read that same env file
  // for both the Vite build and the server.
  const envDir = fileURLToPath(new URL('..', import.meta.url));
  const env = loadEnv(mode, envDir, '');
  const basePath = normalizeBasePath(env.PUBLIC_BASE_PATH);
  const viteBase = basePath ? `${basePath}/` : '/';
  const apiBase = env.VITE_API_BASE || 'http://localhost:8010';
  // WebAuthn requires HTTPS for any non-localhost hostname. mkcert generates a
  // locally-trusted cert so the dev hostname (mapped to 127.0.0.1 in /etc/hosts)
  // works without browser warnings.
  const host = env.VITE_DEV_HOST || 'irc.local.bradroot.me';
  // Opt-in LAN mode for testing on a phone: `VITE_LAN_HOST=Xerxes.local npm
  // run dev` binds to 0.0.0.0 over plain HTTP, skipping mkcert so the device
  // doesn't need to trust a local CA. Password login still works; WebAuthn
  // and Service Worker / push features do not (they require a secure context).
  const lanHost = env.VITE_LAN_HOST;
  // mkcert is dev-server-only HTTPS tooling — it has no business loading under
  // vitest, and historically its native cert generation could crash the test
  // process when the config was resolved from inside vue_client/. Vitest sets
  // VITEST=true before resolving the config, so skip the plugin then; tests
  // never need a cert.
  const underTest = !!process.env.VITEST;

  const basePathAssetsPlugin: Plugin = {
    name: 'lurker-base-path-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        if (pathname === withBasePath('/manifest.webmanifest', basePath)) {
          res.setHeader('Content-Type', 'application/manifest+json');
          res.end(JSON.stringify(manifestFor(basePath), null, 2));
          return;
        }
        if (pathname === withBasePath('/sw.js', basePath)) {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(serviceWorkerFor(basePath));
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      // Files in public/ are copied after Rollup's bundle hooks, so rewrite
      // these two runtime documents after the copy rather than emitting a
      // second asset with the same filename.
      writeFileSync(
        path.join(options.dir, 'manifest.webmanifest'),
        JSON.stringify(manifestFor(basePath), null, 2),
      );
      writeFileSync(path.join(options.dir, 'sw.js'), serviceWorkerFor(basePath));
    },
  };

  return {
    envDir,
    base: viteBase,
    plugins:
      lanHost || underTest
        ? [vue(), basePathAssetsPlugin]
        : [vue(), mkcert(), basePathAssetsPlugin],
    // Build-time constant so the About panel can show the app version without
    // an API round-trip.
    define: {
      APP_VERSION: JSON.stringify(pkg.version),
    },
    server: {
      host: lanHost ? true : host,
      port: 5173,
      allowedHosts: lanHost ? true : undefined,
      // Allow imports from the repo root (one level up from vue_client/),
      // so client code can import the shared settings registry directly
      // instead of maintaining a mirrored copy.
      fs: {
        allow: ['..'],
      },
      proxy: {
        [withBasePath('/api', basePath)]: {
          target: apiBase,
          changeOrigin: true,
        },
        // The local-disk uploader serves files from the backend at /uploads
        // (and the legacy /uploads/local alias, which this prefix also covers).
        // Proxy it so a PUBLIC_BASE_URL pointed at the dev origin (5173) resolves
        // pasted upload links through here instead of hitting the SPA fallback.
        [withBasePath('/uploads', basePath)]: {
          target: apiBase,
          changeOrigin: true,
        },
        [withBasePath('/ws', basePath)]: {
          target: apiBase.replace(/^http/, 'ws'),
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});

function manifestFor(basePath: string): Record<string, unknown> {
  const root = withBasePath('/', basePath);
  const asset = (name: string) => withBasePath(`/${name}`, basePath);
  return {
    name: 'Lurker',
    short_name: 'Lurker',
    description: 'Self-hosted IRC client',
    start_url: root,
    scope: root,
    display: 'standalone',
    background_color: '#0b0b0b',
    theme_color: '#0b0b0b',
    icons: [
      { src: asset('lurker-icon.svg'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: asset('lurker-icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: asset('lurker-icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: asset('lurker-icon-maskable-192.png'),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: asset('lurker-icon-maskable-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

function serviceWorkerFor(basePath: string): string {
  const template = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
  return template.replaceAll('__LURKER_BASE_PATH__', JSON.stringify(basePath));
}
