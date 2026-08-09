// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';

// Shared open-state for the voice-call modal. Mirrors useJoinChannelModal: a
// singleton buffer-scoped toggle so the phone button in either shell's header
// (desktop topic bar, mobile header) opens the same modal instance.
//
// Buffer-scoped, not "active buffer"-scoped: the modal stays pinned to the
// channel/DM it was opened for even if the user switches buffers behind it —
// starting a call is an act on one target, and re-aiming it mid-open would be
// a way to call the wrong room.
const isOpen = ref(false);
const networkId = ref<number | null>(null);
const target = ref('');

export function useCallModal() {
  function open(id: number, tgt: string): void {
    networkId.value = id;
    target.value = tgt;
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
    networkId.value = null;
    target.value = '';
  }
  return { isOpen, networkId, target, open, close };
}
