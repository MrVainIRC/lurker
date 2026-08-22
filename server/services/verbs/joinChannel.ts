// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { channelArg } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'join_channel',
  description:
    'Join a channel on a network. Supply `key` for a +k (password-protected) channel. Returns ' +
    '{ ok: false, error: "not-connected" } when the network is offline. The join and its member ' +
    'list arrive asynchronously — the channel buffer appears once the server confirms.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      key: { type: 'string', description: 'Optional channel key (password) for +k channels.' },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : undefined;
    const ok = ircManager.joinChannel(ctx.userId, networkId, channel.value, key);
    return ok ? { ok: true } : { ok: false, error: 'not-connected' };
  },
});
