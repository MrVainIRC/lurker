// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import {
  apiPath as sharedApiPath,
  assetPath as sharedAssetPath,
  normalizeBasePath,
  webSocketPath as sharedWebSocketPath,
  withBasePath,
  withoutBasePath,
} from '../../../shared/basePath.js';

export const basePath = normalizeBasePath(import.meta.env.BASE_URL || '/');

export const appPath = (path: string): string => withBasePath(path, basePath);
export const apiPath = (path: string): string => sharedApiPath(path, basePath);
export const assetPath = (path: string): string => sharedAssetPath(path, basePath);
export const webSocketPath = (): string => sharedWebSocketPath(basePath);
export { normalizeBasePath, withoutBasePath, withBasePath };
