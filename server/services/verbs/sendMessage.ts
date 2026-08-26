// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'send_message',
  description:
    'Send a PRIVMSG to a channel or peer on a network. Returns { ok: false, error: "not-connected" } when the network is offline — the caller should not retry blindly.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      target: {
        type: 'string',
        description: 'A channel name like "#foo" or a peer nick.',
      },
      text: { type: 'string' },
      replyTo: {
        type: 'string',
        description: 'Optional IRCv3 +reply msgid to attach to the PRIVMSG.',
      },
    },
    required: ['networkId', 'target', 'text'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const target = typeof input.target === 'string' ? input.target : '';
    const text = typeof input.text === 'string' ? input.text : '';
    const replyTo = typeof input.replyTo === 'string' ? input.replyTo : undefined;
    if (!target || !text) return { ok: false, error: 'empty-target-or-text' };
    const ok = ircManager.send(ctx.userId, networkId, target, text, replyTo);
    return ok ? { ok: true } : { ok: false, error: 'not-connected' };
  },
});
