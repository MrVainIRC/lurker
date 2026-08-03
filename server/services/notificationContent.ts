// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What a push notification actually SAYS (#490).
//
// This used to live in vue_client/public/sw.js, which was fine while Web Push
// was the only transport: the payload could stay semantic (nick, target, text)
// and the service worker turned it into a title and a body. APNs and FCM have no
// service worker — they want a composed alert on the wire — so the copy has to be
// written here instead.
//
// Note this is composition, not decision. Whether to push at all is maybePush's
// job in wsHub and is genuinely transport-neutral; this is the part that wasn't,
// because it wasn't on the server at all.
//
// The strings below are a deliberate byte-for-byte port of the service worker's,
// so the move is invisible to anyone already running Lurker. sw.js keeps its copy
// for now and prefers these when present — an old cached worker must not break
// when the server starts sending them. Once every client has cycled, the worker's
// copy is dead code and goes.

import { stripFormatting } from './textMatch.js';

export type PushPayloadKind = 'dm' | 'highlight' | 'always_notify';

/**
 * The semantic push payload wsHub hands to pushService. Deliberately typed (it
 * was `unknown`, which was only tenable while every consumer just re-stringified
 * it): a native transport has to READ these fields to build an alert, so a field
 * quietly dropped here is a notification that renders wrong on a device with
 * nothing else failing.
 */
export interface PushPayload {
  kind: PushPayloadKind;
  networkId: number;
  networkName: string;
  target: string;
  nick?: string | null;
  text?: string | null;
  time?: string;
  messageId?: number | null;
  /** Unread-highlight total for the app icon; absent when it can't have changed. */
  badge?: number;
}

export interface NotificationContent {
  title: string;
  body: string;
  /**
   * Collapse key: later notifications for the same buffer replace earlier ones
   * rather than stacking. Maps to the Notification API's `tag` on Web Push,
   * `aps.thread-id` on APNs, and `android.collapse_key`/`tag` on FCM.
   */
  tag: string;
}

function title(payload: PushPayload): string {
  // A DM is already identified by its sender, so the target would just repeat the
  // nick; a channel highlight needs to say where it happened.
  if (payload.kind === 'dm') {
    return `${payload.nick || 'someone'}${payload.networkName ? ' (' + payload.networkName + ')' : ''}`;
  }
  return `${payload.nick || 'someone'} in ${payload.target || ''}`;
}

export function composeNotification(payload: PushPayload): NotificationContent {
  return {
    title: title(payload),
    // Strip mIRC formatting codes (\x03 colors, \x02 bold, …): a native alert
    // renders body as plain text, so the codes would otherwise arrive as literal
    // control chars on the lock screen (#606).
    body: stripFormatting(payload.text || ''),
    tag: `${payload.networkId || 0}::${payload.target || ''}`,
  };
}
