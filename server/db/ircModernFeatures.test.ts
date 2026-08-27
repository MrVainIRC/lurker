// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import '../test-utils/isolateDb.js';
import { describe, expect, it, beforeAll } from 'vitest';

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let listMessages: typeof import('./messages.js').listMessages;
let setMessageReaction: typeof import('./messages.js').setMessageReaction;
let redactMessage: typeof import('./messages.js').redactMessage;
let editMessage: typeof import('./messages.js').editMessage;
let applyIrcMetadata: typeof import('./ircMetadata.js').applyIrcMetadata;
let listIrcMetadata: typeof import('./ircMetadata.js').listIrcMetadata;

let networkId: number;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ insertMessage, listMessages, setMessageReaction, redactMessage, editMessage } =
    await import('./messages.js'));
  ({ applyIrcMetadata, listIrcMetadata } = await import('./ircMetadata.js'));
  const user = createUser('modern-features');
  networkId = createNetwork(user.id, {
    name: 'modern',
    host: 'irc.example.test',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!.id;
});

describe('IRC modern message state', () => {
  it('persists +reply and idempotent react/unreact state', () => {
    insertMessage({
      networkId,
      target: '#chat',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'parent',
      msgid: 'parent-1',
    });
    insertMessage({
      networkId,
      target: '#chat',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'reply',
      msgid: 'reply-1',
      replyTo: 'parent-1',
    });

    expect(setMessageReaction(networkId, '#chat', 'parent-1', 'bob', '👍', true)).toBe(true);
    expect(setMessageReaction(networkId, '#chat', 'parent-1', 'bob', '👍', true)).toBe(true);
    expect(setMessageReaction(networkId, '#chat', 'parent-1', 'alice', '❤️', true)).toBe(true);

    const parent = listMessages(networkId, '#chat', { limit: 10 }).find(
      (message) => message.msgid === 'parent-1',
    );
    const reply = listMessages(networkId, '#chat', { limit: 10 }).find(
      (message) => message.msgid === 'reply-1',
    );
    expect(parent?.reactions).toEqual([
      { actor: 'alice', reaction: '❤️' },
      { actor: 'bob', reaction: '👍' },
    ]);
    expect(reply?.replyTo).toBe('parent-1');

    expect(setMessageReaction(networkId, '#chat', 'parent-1', 'bob', '👍', false)).toBe(true);
    expect(
      listMessages(networkId, '#chat', { limit: 10 }).find((m) => m.msgid === 'parent-1')
        ?.reactions,
    ).toEqual([{ actor: 'alice', reaction: '❤️' }]);
  });

  it('redacts persisted text while retaining the row and relation', () => {
    insertMessage({
      networkId,
      target: 'Bob',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'secret',
      msgid: 'dm-1',
      replyTo: 'missing-parent',
    });
    expect(redactMessage(networkId, 'bob', 'dm-1', 'removed by moderator')).toBe(true);
    const row = listMessages(networkId, 'BOB', { limit: 10 }).find((m) => m.msgid === 'dm-1');
    expect(row?.text).toBeNull();
    expect(row?.redacted).toBe(true);
    expect(row?.redactionReason).toBe('removed by moderator');
    expect(row?.replyTo).toBe('missing-parent');
  });

  it('round-trips an edited message through the normal history reader', () => {
    insertMessage({
      networkId,
      target: '#chat-edit',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'before',
      msgid: 'edit-1',
    });
    expect(editMessage(networkId, '#CHAT-EDIT', 'edit-1', 'ALICE', 'after')).toBe(true);
    expect(listMessages(networkId, '#chat-edit', { limit: 10 })).toEqual([
      expect.objectContaining({
        msgid: 'edit-1',
        nick: 'alice',
        text: 'after',
        redacted: undefined,
      }),
    ]);
  });
});

describe('generic IRC metadata', () => {
  it('stores unknown keys, updates them, and deletes them with folded targets', () => {
    applyIrcMetadata(networkId, '#Chat', 'custom/key', 'one', 'public');
    applyIrcMetadata(networkId, '#chat', 'custom/key', 'two', 'public');
    expect(listIrcMetadata(networkId, '#CHAT')).toEqual([
      { networkId, target: '#chat', key: 'custom/key', value: 'two', visibility: 'public' },
    ]);
    applyIrcMetadata(networkId, '#chat', 'custom/key', null);
    expect(listIrcMetadata(networkId, '#chat')).toEqual([]);
  });
});
