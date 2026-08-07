// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { applySpoilerMarkup } from './spoilerMarkup.js';
import { splitTextByTokens } from './nickColor.js';

// A spoiler on the wire is any run whose foreground and background match. We
// emit grey on grey (14,14) rather than black on black — see the note in
// spoilerMarkup.ts for why the colour is the sender's problem now.
const OPEN = '\x0314,14';
const CLOSE = '\x03';

describe('applySpoilerMarkup', () => {
  it('leaves text with no double-pipes untouched', () => {
    expect(applySpoilerMarkup('hello world')).toBe('hello world');
    expect(applySpoilerMarkup('')).toBe('');
    expect(applySpoilerMarkup('a | b')).toBe('a | b');
  });

  it('rewrites a basic ||spoiler|| into IRC spoiler codes', () => {
    expect(applySpoilerMarkup('||secret||')).toBe(`${OPEN}secret${CLOSE}`);
  });

  it('preserves the text around a spoiler', () => {
    expect(applySpoilerMarkup('the answer is ||42|| ok?')).toBe(
      `the answer is ${OPEN}42${CLOSE} ok?`,
    );
  });

  it('rewrites multiple spoilers in one message', () => {
    expect(applySpoilerMarkup('||a|| and ||b||')).toBe(`${OPEN}a${CLOSE} and ${OPEN}b${CLOSE}`);
  });

  it('pairs non-greedily — the nearest closing || wins', () => {
    // ||a||b||c|| -> spoiler(a), literal b, spoiler(c)
    expect(applySpoilerMarkup('||a||b||c||')).toBe(`${OPEN}a${CLOSE}b${OPEN}c${CLOSE}`);
  });

  it('leaves an unmatched || literal', () => {
    expect(applySpoilerMarkup('||unclosed')).toBe('||unclosed');
    expect(applySpoilerMarkup('trailing||')).toBe('trailing||');
  });

  it('leaves an empty |||| literal', () => {
    expect(applySpoilerMarkup('||||')).toBe('||||');
  });

  it('treats \\|| as an escape, emitting a literal || and no spoiler', () => {
    expect(applySpoilerMarkup('exit code \\|| 1')).toBe('exit code || 1');
    expect(applySpoilerMarkup('\\||not a spoiler\\||')).toBe('||not a spoiler||');
  });

  it('allows an escaped || inside a real spoiler', () => {
    expect(applySpoilerMarkup('||has \\|| inside||')).toBe(`${OPEN}has || inside${CLOSE}`);
  });

  it('leaves a lone backslash literal', () => {
    expect(applySpoilerMarkup('a \\ b')).toBe('a \\ b');
    expect(applySpoilerMarkup('path\\to\\file')).toBe('path\\to\\file');
  });
});

// Everything above pins the bytes we emit. This pins the thing that actually
// matters: that our own renderer reads them back as a spoiler. The two halves
// live in different files and were free to drift — a pair the parser didn't
// recognise would ship as visible plaintext, which for a spoiler is the whole
// failure.
describe('applySpoilerMarkup → splitTextByTokens round trip', () => {
  const parse = (text: string) => splitTextByTokens(text, null, null, null);

  it('emits a run our own parser recognises as a spoiler', () => {
    expect(parse(applySpoilerMarkup('||secret||'))).toEqual([
      { text: 'secret', spoiler: true, fg: 14 },
    ]);
  });

  // The delimiter is two digits and so is the colour code, so a spoiler opening
  // on a digit is where a greedy parse would go wrong: `\x0314,14` + `42` must
  // read as grey-on-grey plus the text "42", not as colour 14,1442.
  it('does not swallow leading digits of the hidden text', () => {
    expect(parse(applySpoilerMarkup('the answer is ||42||'))).toEqual([
      { text: 'the answer is ' },
      { text: '42', spoiler: true, fg: 14 },
    ]);
  });

  it('still recognises an incoming 01,01 spoiler from another client', () => {
    expect(parse('\x0301,01secret\x03')).toEqual([{ text: 'secret', spoiler: true, fg: 1 }]);
  });
});
