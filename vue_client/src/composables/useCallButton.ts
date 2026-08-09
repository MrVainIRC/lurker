// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The header phone button, shared by both shells (desktop topic bar, mobile
// header) so the two can't drift on when a call is offered or what the button
// says. It only decides *presentation and intent* — the click opens CallModal,
// which owns the confirm and every op control; nothing here starts a call.
//
// Channels and DMs both get it. On a channel the live participant count rides
// alongside (webhook-driven, hydrated on connect — see stores/callPresence);
// a DM call broadcasts no presence by design, so it never shows a number.

import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { useConfigStore } from '../stores/config.js';
import { useVoiceStore } from '../stores/voice.js';
import { useCallPresenceStore } from '../stores/callPresence.js';
import { useActiveBuffer } from './useActiveBuffer.js';
import { useCallModal } from './useCallModal.js';

export interface CallButtonState {
  /** Render the button at all: voice is enabled and this is a callable buffer. */
  canCall: ComputedRef<boolean>;
  /** The active buffer's call is the one we're currently connected to. */
  inThisCall: ComputedRef<boolean>;
  /** Live participants in this channel's call; always 0 for a DM. */
  callCount: ComputedRef<number>;
  /** Title/aria label, which doubles as the count's tooltip. */
  callLabel: ComputedRef<string>;
  openCall: () => void;
}

export function useCallButton(): CallButtonState {
  const config = useConfigStore();
  const voice = useVoiceStore();
  const presence = useCallPresenceStore();
  const callModal = useCallModal();
  const { active, isChannel, isServerBuffer, isVirtual } = useActiveBuffer();

  const canCall = computed(
    () => config.voiceEnabled && !!active.value && !isVirtual.value && !isServerBuffer.value,
  );

  const inThisCall = computed(
    () =>
      voice.active &&
      !!active.value &&
      voice.networkId === active.value.networkId &&
      voice.target === active.value.target,
  );

  const callCount = computed(() => {
    if (!isChannel.value || !active.value) return 0;
    return presence.countFor(active.value.networkId, active.value.target);
  });

  const callLabel = computed(() => {
    if (inThisCall.value) return 'You are in this call';
    if (callCount.value > 0) {
      const n = callCount.value;
      return `Join call — ${n} ${n === 1 ? 'person' : 'people'} in it`;
    }
    return 'Start a voice call';
  });

  function openCall(): void {
    const b = active.value;
    if (!b) return;
    callModal.open(b.networkId, b.target);
  }

  return { canCall, inThisCall, callCount, callLabel, openCall };
}
