<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Persistent floating voice-call panel. Mounted once globally in App.vue (reads
  the singleton voice store), so an active call survives buffer switches and
  the Desktop<->Mobile shell swap. Shows who's in the call, who's speaking, a
  per-participant volume slider, and mute/leave controls.
-->

<template>
  <!-- Also rendered when only an error remains: a failed call must say WHY
       (403/503, SFU unreachable, mic denied) instead of silently vanishing. -->
  <div
    v-if="voice.active || voice.connecting || voice.error"
    class="call-bar"
    role="dialog"
    aria-label="Voice call"
  >
    <div class="call-head">
      <span class="dot" :class="{ live: voice.active }" aria-hidden="true"></span>
      <span class="call-title">{{ voice.label || 'Voice call' }}</span>
      <span class="call-status">{{ statusText }}</span>
      <IconButton
        v-if="!voice.active && !voice.connecting"
        icon="fa-xmark"
        label="Dismiss"
        @click="voice.clearError()"
      />
    </div>

    <div v-if="voice.active || voice.connecting" class="call-body">
      <ul v-if="voice.participants.length" class="call-parts">
        <li v-for="id in voice.participants" :key="id">
          <div class="part-row" :class="{ talking: voice.speaking.includes(id) }">
            <i
              class="fa-solid"
              :class="voice.speaking.includes(id) ? 'fa-volume-high' : 'fa-user'"
              aria-hidden="true"
            ></i>
            <span class="part-nick" :title="id">{{ id }}</span>
            <IconButton
              v-if="amOp"
              icon="fa-microphone-slash"
              :label="`Mute ${id} for everyone`"
              @click="moderate(id, 'mute')"
            />
            <IconButton
              v-if="amOp"
              icon="fa-user-slash"
              :label="`Remove ${id} from call`"
              danger
              @click="moderate(id, 'remove')"
            />
          </div>
          <input
            class="vol"
            type="range"
            min="0"
            max="100"
            :value="volPct(id)"
            :aria-label="`Volume for ${id}`"
            @input="onVol(id, $event)"
          />
        </li>
      </ul>
      <p v-else class="call-empty">Just you so far…</p>
    </div>

    <div v-if="voice.active || voice.connecting" class="call-actions">
      <IconButton
        :icon="voice.muted ? 'fa-microphone-slash' : 'fa-microphone'"
        :label="voice.muted ? 'Unmute' : 'Mute'"
        :danger="voice.muted"
        @click="voice.toggleMute()"
      />
      <IconButton icon="fa-phone-slash" label="Leave call" danger @click="voice.leave()" />
    </div>

    <p v-if="voice.error" class="call-error">{{ voice.error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useVoiceStore } from '../stores/voice.js';
import { useBuffersStore, bufferKey } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useToastsStore } from '../stores/toasts.js';
import { canModerateCall } from '../../../shared/voiceModes.js';
import { api } from '../api.js';
import IconButton from './IconButton.vue';

const voice = useVoiceStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();

const statusText = computed(() => {
  if (voice.connecting) return 'connecting…';
  if (voice.active) return 'connected';
  return 'call failed';
});

// ─── Op moderation (the same shared gate the server enforces) ───────────────
// The server enforces; showing the buttons only to ops is UX, not security.
const amOp = computed(() => {
  if (voice.networkId == null || !voice.target) return false;
  const b = buffers.byKey(bufferKey(voice.networkId, voice.target));
  const selfNick = networks.states[voice.networkId]?.nick;
  if (!b || !selfNick) return false;
  const me = b.members?.find((m) => m.nick.toLowerCase() === selfNick.toLowerCase());
  return canModerateCall(me?.modes ?? []);
});

async function moderate(identity: string, action: 'mute' | 'remove') {
  if (voice.networkId == null) return;
  try {
    await api('/api/voice/moderate', {
      method: 'POST',
      body: { networkId: voice.networkId, target: voice.target, action, identity },
    });
  } catch (e: unknown) {
    // A toast, NOT voice.error — that field means "the CALL failed" and keeps
    // the bar rendered; a failed moderation click must not wedge it open.
    useToastsStore().push({
      title: `Could not ${action} ${identity}`,
      body: e instanceof Error ? e.message : 'the server rejected the action',
      kind: 'warn',
    });
  }
}

function volPct(id: string): number {
  return Math.round((voice.volumes[id] ?? 1) * 100);
}
function onVol(id: string, e: Event) {
  voice.setVolume(id, Number((e.target as HTMLInputElement).value) / 100);
}
</script>

<style scoped>
.call-bar {
  position: fixed;
  right: var(--space-6);
  bottom: var(--space-6);
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  width: 240px;
  max-width: calc(100vw - var(--space-9));
  max-height: 50vh;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-popover);
}
.call-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--fg-muted);
  flex: 0 0 auto;
}
.dot.live {
  background: var(--good);
}
.call-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.call-status {
  margin-left: auto;
  color: var(--fg-muted);
}
.call-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-3) var(--space-4);
  min-height: 0;
}
.call-parts {
  list-style: none;
  margin: 0;
  padding: 0;
}
.call-parts li {
  padding: var(--space-1) 0;
}
.part-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.part-row i {
  color: var(--fg-muted);
}
.part-row.talking i,
.part-row.talking .part-nick {
  color: var(--accent);
}
.part-nick {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vol {
  width: 100%;
  margin: var(--space-1) 0 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.call-empty {
  margin: 0;
  color: var(--fg-muted);
}
.call-actions {
  display: flex;
  justify-content: space-around;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
}
.call-error {
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  color: var(--bad);
}
</style>
