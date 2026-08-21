// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_FILE_TYPES,
  hasUploaderChoice,
  iconForMime,
  isUploadableType,
} from './uploaders.js';

describe('hasUploaderChoice', () => {
  // The bug this exists to prevent: on app.lurker.chat there is exactly ONE
  // uploader (the locked dropper) and personal uploaders are off, so the settings
  // pane rendered the same destination twice — once by name, once as the "Server
  // default" pseudo-row that resolves to it — and asked the user to choose.
  it('is false on a hosted cell: one uploader, and you cannot add another', () => {
    expect(hasUploaderChoice(1, false)).toBe(false);
  });

  it('is true when you may add your own, even with a single uploader today', () => {
    // The picker still has a job — the list is about to grow.
    expect(hasUploaderChoice(1, true)).toBe(true);
    expect(hasUploaderChoice(0, true)).toBe(true);
  });

  it('is true on a locked-down instance that offers several to pick between', () => {
    expect(hasUploaderChoice(3, false)).toBe(true);
  });
});

describe('iconForMime', () => {
  it('distinguishes the types a thumbnail-less row can be', () => {
    expect(iconForMime('video/mp4')).toBe('fa-file-video');
    expect(iconForMime('audio/mpeg')).toBe('fa-file-audio');
    expect(iconForMime('text/plain')).toBe('fa-file-lines');
    expect(iconForMime('image/png')).toBe('fa-file-image');
    expect(iconForMime(null)).toBe('fa-file');
  });

  // #788. JSON is a text file IANA files under `application/`, so a prefix test drops
  // it onto the generic page glyph this function exists to get away from.
  it('gives the text glyph to every dialect the uploader can produce', () => {
    expect(iconForMime('text/markdown')).toBe('fa-file-lines');
    expect(iconForMime('application/json')).toBe('fa-file-lines');
    // Not a blanket application/ pass — that would put the glyph on a PDF.
    expect(iconForMime('application/pdf')).toBe('fa-file');
  });
});

describe('isUploadableType', () => {
  // Deliberately looser than the server's accepted set: these gates exist to ignore
  // things that obviously aren't uploads, not to enforce policy. The server's 415
  // names the real reason, which beats a drop that silently does nothing.
  it('lets media through for the server to judge', () => {
    expect(isUploadableType('video/webm')).toBe(true); // server will 415 it, with a reason
    expect(isUploadableType('image/png')).toBe(true);
    expect(isUploadableType('text/plain')).toBe(true);
    expect(isUploadableType('application/pdf')).toBe(false);
  });

  // A dropped `.md` used to be silently ignored here — no upload, no error, nothing
  // (#788). The picker greying it out was the other half of the same gap.
  it('accepts the text dialects a file drop can carry', () => {
    expect(isUploadableType('text/markdown')).toBe(true);
    expect(isUploadableType('application/json')).toBe(true);
    // Any text/* — the server takes signature-less UTF-8 whatever it was called.
    expect(isUploadableType('text/x-python')).toBe(true);
  });

  it('offers the dialects in the file picker, by mime AND by extension', () => {
    // Both are needed: macOS greys out anything the attribute doesn't match, with no
    // "All Files" escape, and platforms disagree about what they call a `.md`.
    for (const token of ['text/markdown', 'application/json', '.md', '.json']) {
      expect(ACCEPTED_FILE_TYPES.split(',')).toContain(token);
    }
  });
});
