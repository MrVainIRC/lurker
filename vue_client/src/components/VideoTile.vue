<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  One video tile in the call window. It owns the attach/detach of its LiveKit
  track to the <video> element — REQUIRED for adaptiveStream to deliver remote
  video (an unattached track never starts flowing, and detaching pauses it).
  Self camera tiles are mirrored and muted; screen-share tiles are letterboxed.
  Overlay colors are deliberately literal: they sit on live video, not on the
  app's themed surfaces.
-->

<template>
  <div ref="tileEl" class="video-tile" :class="{ screen: source === 'screen_share' }">
    <video
      ref="el"
      autoplay
      playsinline
      :muted="self"
      :class="{ mirror: self && source !== 'screen_share' }"
    ></video>
    <button type="button" class="fs" title="Fullscreen" aria-label="Fullscreen" @click="fullscreen">
      <i class="fa-solid fa-expand" aria-hidden="true"></i>
    </button>
    <span class="tile-label">
      <i v-if="source === 'screen_share'" class="fa-solid fa-desktop" aria-hidden="true"></i>
      {{ self ? 'You' : identity }}<span v-if="source === 'screen_share'"> · screen</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useVoiceStore } from '../stores/voice.js';

const props = defineProps<{ identity: string; source: string; self: boolean }>();
const voice = useVoiceStore();
const el = ref<HTMLVideoElement | null>(null);
const tileEl = ref<HTMLElement | null>(null);

function fullscreen() {
  const node = tileEl.value;
  if (!node) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void node.requestFullscreen?.();
}

onMounted(() => {
  if (el.value) voice.attachVideo(props.identity, props.source, el.value, props.self);
});
onBeforeUnmount(() => {
  if (el.value) voice.detachVideo(props.identity, props.source, el.value, props.self);
});
</script>

<style scoped>
.video-tile {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
  overflow: hidden;
  border: 1px solid var(--border);
}
.video-tile video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.video-tile.screen video {
  object-fit: contain;
}
.video-tile video.mirror {
  transform: scaleX(-1);
}
/* When a tile IS the fullscreen element, fill the screen and letterbox. */
.video-tile:fullscreen {
  aspect-ratio: auto;
  border: none;
}
.video-tile:fullscreen video {
  object-fit: contain;
}
.fs {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-1) var(--space-2);
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
}
/* Hover-capable devices reveal on hover; everywhere else the button is simply
   visible — an opacity-0 base would make fullscreen unreachable on touch. */
@media (hover: hover) {
  .fs {
    opacity: 0;
    transition: opacity 80ms linear;
  }
}
.video-tile:hover .fs,
.fs:focus-visible {
  opacity: 1;
}
.tile-label {
  position: absolute;
  left: var(--space-2);
  bottom: var(--space-2);
  max-width: calc(100% - var(--space-4));
  padding: 0 var(--space-2);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
