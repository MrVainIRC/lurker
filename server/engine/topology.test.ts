// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine's protocol major is copied into two artefacts that CI and
// self-hosters read: the image tag the compose overlay pins, and the tag the
// publish workflow derives. The workflow reads the constant from source; this
// pins the overlay to it, so a PROTOCOL_MAJOR bump cannot ship a v2 engine to
// people pulling `engine-1`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_MAJOR } from './protocol.js';

const root = path.join(import.meta.dirname, '..', '..');

describe('engine topology artefacts', () => {
  it('docker-compose.engine.yml pins the image tag for this PROTOCOL_MAJOR', () => {
    const overlay = fs.readFileSync(path.join(root, 'docker-compose.engine.yml'), 'utf8');
    const m = /image:\s*\$\{LURKER_ENGINE_IMAGE:-ghcr\.io\/amiantos\/lurker:engine-(\d+)\}/.exec(
      overlay,
    );
    expect(m, 'the overlay should pin ghcr.io/amiantos/lurker:engine-<major>').not.toBeNull();
    expect(Number(m![1])).toBe(PROTOCOL_MAJOR);
  });

  it('the publish workflow reads the major from protocol.ts rather than hardcoding it', () => {
    const wf = fs.readFileSync(path.join(root, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(wf).toMatch(/PROTOCOL_MAJOR = \(\[0-9\]\+\);/);
    expect(wf).not.toMatch(/^\s*MAJOR=\d+\s*$/m);
    // And it never trips on the version bump every release makes.
    expect(wf).not.toMatch(/git diff --quiet[^\n]*package\.json/);
  });
});
