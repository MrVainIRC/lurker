// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

export interface IrcMetadataEntry {
  key: string;
  value: string;
  visibility: string;
}

export type IrcMetadataRows = Record<string, Array<IrcMetadataEntry>>;

/** Resolve a public HTTPS avatar from the same metadata rows used by the member list. */
export function avatarUrlForMetadata(
  rows: IrcMetadataRows | undefined,
  nick: string | null | undefined,
  selfNick: string | null | undefined,
): string | null {
  if (!rows || !nick) return null;
  const foldedNick = nick.toLowerCase();
  const isOwnNick = !!selfNick && selfNick.toLowerCase() === foldedNick;
  const target =
    (isOwnNick && rows['*'] ? '*' : undefined) ||
    Object.keys(rows).find((key) => key.toLowerCase() === foldedNick);
  const value = target ? rows[target].find((entry) => entry.key === 'avatar')?.value : '';
  if (!value) return null;
  try {
    const url = new URL(value.replace(/\{size\}/g, '64'));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
