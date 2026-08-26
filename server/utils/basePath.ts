// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import {
  apiPath as sharedApiPath,
  assetPath as sharedAssetPath,
  normalizeBasePath,
  webSocketPath as sharedWebSocketPath,
  withBasePath,
} from '../../shared/basePath.js';

export { normalizeBasePath, withBasePath };

export function publicBasePath(): string {
  return normalizeBasePath(process.env.PUBLIC_BASE_PATH);
}

export function basePath(path: string): string {
  return withBasePath(path, publicBasePath());
}

export function apiPath(path: string): string {
  return sharedApiPath(path, publicBasePath());
}

export function webSocketPath(): string {
  return sharedWebSocketPath(publicBasePath());
}

export function assetPath(path: string): string {
  return sharedAssetPath(path, publicBasePath());
}
