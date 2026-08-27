// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Generic HTTP multipart uploader. It covers simple self-hosted paste/file
// services without making Lurker know their product-specific API. RustyPaste is
// the primary example: POST multipart `file`, send its optional auth token as
// the raw `Authorization` header, and read the returned URL from the body.

import { USER_AGENT } from '../../utils/userAgent.js';
import { postMultipart, isOk, jsonBody } from './multipart.js';
import type { UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 'custom';
export const label = 'Custom HTTP uploader';
export const capabilities: DriverCapabilities = {
  creatable: true,
  storesRemotely: true,
  supportsDelete: false,
  mintsKeys: false,
  acceptsContentClasses: ['image', 'text', 'media'],
};

export const configSchema: ConfigField[] = [
  {
    key: 'url',
    label: 'Upload URL',
    type: 'string',
    required: true,
    default: '',
    description: 'HTTP(S) endpoint that accepts the multipart upload (e.g. a RustyPaste URL).',
  },
  {
    key: 'file_field',
    label: 'File field name',
    type: 'string',
    required: false,
    default: 'file',
    description: 'Multipart field containing the file. RustyPaste uses "file".',
  },
  {
    key: 'auth_header',
    label: 'Auth header',
    type: 'string',
    required: false,
    default: 'Authorization',
    description: 'Optional header name for the token, usually Authorization.',
  },
  {
    key: 'auth_token',
    label: 'Auth token',
    type: 'secret',
    required: false,
    default: '',
    description:
      'Optional token sent unchanged in the auth header. RustyPaste expects its token without a Bearer prefix.',
  },
];

function configError(message: string): Error {
  return Object.assign(new Error(message), { code: 'PROVIDER_CONFIG' });
}

function endpoint(config: Record<string, string>): string {
  const raw = (config.url || '').trim();
  if (!raw) throw configError('custom uploader requires a url');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError('custom uploader url must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw configError('custom uploader url must use http or https');
  }
  return parsed.toString();
}

function headerName(config: Record<string, string>): string | null {
  const raw = (config.auth_header || 'Authorization').trim();
  if (!raw) return null;
  // Header names are written into node's request options; reject separators
  // rather than allowing configuration to smuggle additional headers.
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(raw)) {
    throw configError('custom uploader auth header is invalid');
  }
  return raw;
}

function fileField(config: Record<string, string>): string {
  const raw = (config.file_field || 'file').trim();
  if (!raw || !/^[A-Za-z0-9_.-]{1,64}$/.test(raw)) {
    throw configError('custom uploader file field is invalid');
  }
  return raw;
}

function responseUrl(text: string): string | null {
  const raw = text.trim();
  const candidates: unknown[] = [raw];
  const parsed = jsonBody({ status: 200, headers: {}, text });
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { url?: unknown; data?: { url?: unknown } };
    candidates.push(body.url, body.data?.url);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      // Try the next supported response shape.
    }
  }
  return null;
}

export async function upload(
  source: UploadSource,
  { filename, mime, onProgress }: UploadMeta,
  config: Record<string, string> = {},
): Promise<UploadResult> {
  const url = endpoint(config);
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  const token = config.auth_token || '';
  const auth = headerName(config);
  if (token && auth) {
    if (/[\r\n]/.test(token)) throw configError('custom uploader auth token is invalid');
    headers[auth] = token;
  }

  const resp = await postMultipart(
    url,
    [{ name: fileField(config), filename, contentType: mime, source }],
    { headers, onProgress },
  );
  if (!isOk(resp)) {
    const text = resp.text.slice(0, 200);
    throw Object.assign(new Error(`custom uploader failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }

  const result = responseUrl(resp.text);
  if (!result) {
    throw Object.assign(new Error('custom uploader returned no absolute http(s) url'), {
      code: 'PROVIDER_ERROR',
    });
  }
  return { url: result };
}
