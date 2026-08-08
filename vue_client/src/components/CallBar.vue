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
    :class="{ 'has-video': voice.videoTiles.length }"
    :style="barStyle"
    role="dialog"
    aria-label="Voice call"
  >
    <div class="call-head" @pointerdown="onHeaderDown">
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
      <div v-if="voice.videoTiles.length" class="video-grid">
        <VideoTile
          v-for="t in voice.videoTiles"
          :key="`${t.identity}|${t.source}`"
          :identity="t.identity"
          :source="t.source"
          :self="t.self"
        />
      </div>
      <ul v-if="voice.participants.length" class="call-parts">
        <li v-for="id in voice.participants" :key="id">
          <div class="part-row" :class="{ talking: voice.speaking.includes(id) }">
            <i
              class="fa-solid"
              :class="voice.speaking.includes(id) ? 'fa-volume-high' : 'fa-user'"
              aria-hidden="true"
            ></i>
            <span class="part-nick" :title="partName(id)">
              {{ partName(id) }}<span v-if="isGuestIdentity(id)" class="guest-tag">guest</span>
            </span>
            <IconButton
              v-if="amOp"
              icon="fa-microphone-slash"
              :label="`Mute ${partName(id)} for everyone`"
              @click="moderate(id, 'mute')"
            />
            <IconButton
              v-if="amOp"
              icon="fa-user-slash"
              :label="`Remove ${partName(id)} from call`"
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
            :aria-label="`Volume for ${partName(id)}`"
            @input="onVol(id, $event)"
          />
        </li>
      </ul>
      <p v-else class="call-empty">Just you so far…</p>
    </div>

    <div v-if="voice.active || voice.connecting" class="call-actions">
      <!-- Listen-only guests get no mute toggle: an unmute would prompt for
           mic permission and then be refused by the SFU. -->
      <IconButton
        v-if="voice.canPublish"
        :icon="voice.muted ? 'fa-microphone-slash' : 'fa-microphone'"
        :label="voice.muted ? 'Unmute' : 'Mute'"
        :danger="voice.muted"
        @click="voice.toggleMute()"
      />
      <IconButton
        v-if="voice.canPublish"
        :icon="voice.cameraOn ? 'fa-video' : 'fa-video-slash'"
        :label="voice.cameraOn ? 'Turn camera off' : 'Turn camera on'"
        @click="voice.toggleCamera()"
      />
      <IconButton
        v-if="voice.canPublish"
        icon="fa-desktop"
        :label="voice.screenOn ? 'Stop sharing screen' : 'Share screen'"
        :danger="voice.screenOn"
        @click="voice.toggleScreen()"
      />
      <IconButton icon="fa-phone-slash" label="Leave call" danger @click="voice.leave()" />
    </div>

    <p v-if="voice.error" class="call-error">{{ voice.error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useVoiceStore } from '../stores/voice.js';
import { useBuffersStore, bufferKey } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useToastsStore } from '../stores/toasts.js';
import { canModerateCall, isGuestIdentity, guestDisplayName } from '../../../shared/voiceModes.js';
import { api } from '../api.js';
import IconButton from './IconButton.vue';
import VideoTile from './VideoTile.vue';

const voice = useVoiceStore();
const buffers = useBuffersStore();
const networks = useNetworksStore();

const statusText = computed(() => {
  if (voice.connecting) return 'connecting…';
  if (voice.active) return 'connected';
  return 'call failed';
});

// ─── Drag (pointer events — memory rule: pointerdown, not mousedown/hover) ──
// Positioned by default via CSS (bottom-right); once dragged, an explicit
// left/top pins it. Clamped so the header can never leave the viewport.
const pos = ref<{ x: number; y: number } | null>(null);
let grabOffset = { x: 0, y: 0 };
const barStyle = computed(() =>
  pos.value
    ? { left: `${pos.value.x}px`, top: `${pos.value.y}px`, right: 'auto', bottom: 'auto' }
    : {},
);
function onHeaderDown(e: PointerEvent) {
  // Buttons in the header (dismiss) must stay clickable, not start a drag.
  if ((e.target as HTMLElement).closest('button')) return;
  const bar = (e.currentTarget as HTMLElement).closest('.call-bar') as HTMLElement | null;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  grabOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}
function onDragMove(e: PointerEvent) {
  pos.value = {
    x: Math.max(4, Math.min(window.innerWidth - 60, e.clientX - grabOffset.x)),
    y: Math.max(4, Math.min(window.innerHeight - 40, e.clientY - grabOffset.y)),
  };
}
function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
}
onBeforeUnmount(onDragEnd);

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

/** Human name for a participant row — guests show their picked name, not the
 *  raw machine identity (the guest-tag badge carries the "guest" fact). */
function partName(id: string): string {
  return guestDisplayName(id);
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
  min-width: 220px;
  min-height: 96px;
  max-width: calc(100vw - var(--space-9));
  max-height: calc(100vh - var(--space-9));
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
  resize: both;
}
.call-bar.has-video {
  width: 480px;
  min-height: 280px;
}
.call-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
  touch-action: none;
  flex: 0 0 auto;
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
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-3);
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
.guest-tag {
  margin-left: var(--space-2);
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
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
