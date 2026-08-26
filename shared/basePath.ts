// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/** Normalize a deployment path to either an empty string or a slash-prefixed path. */
export function normalizeBasePath(value: string | undefined | null): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

/** Prefix an application-relative URL while leaving absolute URLs untouched. */
export function withBasePath(path: string, basePath: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;

  const base = normalizeBasePath(basePath);
  if (!base) return path;

  const match = /^([^?#]*)([?#].*)?$/.exec(path);
  const pathname = match?.[1] ?? path;
  const suffix = match?.[2] ?? '';
  if (pathname === base || pathname.startsWith(`${base}/`)) return path;
  return `${base}${pathname === '/' ? '/' : pathname}${suffix}`;
}

/** Remove the configured prefix from a browser pathname for route comparisons. */
export function withoutBasePath(pathname: string, basePath: string): string {
  const base = normalizeBasePath(basePath);
  if (!base || (pathname !== base && !pathname.startsWith(`${base}/`))) return pathname;
  const stripped = pathname.slice(base.length);
  return stripped || '/';
}

export function apiPath(path: string, basePath: string): string {
  return withBasePath(`/api${path.startsWith('/') ? path : `/${path}`}`, basePath);
}

export function webSocketPath(basePath: string): string {
  return withBasePath('/ws', basePath);
}

export function assetPath(path: string, basePath: string): string {
  return withBasePath(path.startsWith('/') ? path : `/${path}`, basePath);
}
