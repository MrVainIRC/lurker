// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { swallowDeadTtyErrors } from './processGuards.js';

function errWithCode(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(code);
  e.code = code;
  return e;
}

describe('swallowDeadTtyErrors', () => {
  it('is the difference between surviving and crashing: an unhandled stream error throws', () => {
    const stream = new EventEmitter();
    expect(() => stream.emit('error', errWithCode('EIO'))).toThrow('EIO');
  });

  it('swallows EPIPE and EIO (the dead-pty write errors)', () => {
    const stream = new EventEmitter();
    swallowDeadTtyErrors(stream);
    expect(() => stream.emit('error', errWithCode('EPIPE'))).not.toThrow();
    expect(() => stream.emit('error', errWithCode('EIO'))).not.toThrow();
  });

  it('rethrows every other stream error', () => {
    const stream = new EventEmitter();
    swallowDeadTtyErrors(stream);
    expect(() => stream.emit('error', errWithCode('ENOSPC'))).toThrow('ENOSPC');
    expect(() => stream.emit('error', new Error('no code'))).toThrow('no code');
  });
});
