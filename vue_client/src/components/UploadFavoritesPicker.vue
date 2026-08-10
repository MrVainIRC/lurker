<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Quick access to starred uploads, popped out of the status bar's star button.

  The uploads browser can already filter to starred files, but getting a gif into a
  message through it is: open modal, click a chip, find the tile, insert, modal
  closes. That is a browse, and the whole point of starring something is that you
  are NOT browsing for it — you know exactly which one you want and you want it in
  the line you are already typing. So this is deliberately not a small copy of the
  modal: no search, no filters, no paging, no delete. A grid of thumbnails; click
  one and its URL lands at the caret.

  A GRID rather than VerticalPopover's rows, because recognition here is visual —
  a column of 24px thumbs next to filenames is exactly the squint the uploads
  browser moved away from (#547). It follows MircColorPicker's shape instead: a
  panel absolutely positioned inside StatusBar's positioning context.

  ⚠ It inherits that popover's iOS focus contract too — a `div role=button` with
  @mousedown.prevent, acting on `click` (end of touch), never pointerdown. Losing
  focus here would dismiss the soft keyboard mid-compose, and inserting into a
  textarea that just lost its caret puts the URL in the wrong place.
-->

<template>
  <div ref="panelEl" class="favorites-picker" @pointerdown.stop @mousedown.prevent.stop>
    <div class="head">
      <span class="title">starred uploads</span>
      <div
        role="button"
        class="close"
        tabindex="0"
        title="Close"
        aria-label="Close"
        @mousedown.prevent
        @click="emit('close')"
        @keydown.enter.prevent="emit('close')"
        @keydown.space.prevent="emit('close')"
      >
        <i class="fa-solid fa-xmark"></i>
      </div>
    </div>

    <!-- The error rides ABOVE the grid rather than replacing it: every open
         refetches, and a failed refresh should not take away the perfectly usable
         list from the last one. -->
    <p v-if="uploads.favoritesError" class="note error">{{ uploads.favoritesError }}</p>
    <p v-if="!uploads.favorites.length && uploads.favoritesLoading" class="note">Loading…</p>
    <p v-else-if="!uploads.favorites.length && !uploads.favoritesError" class="note">
      Nothing starred yet. Star an upload in the uploads browser and it shows up here.
    </p>

    <div v-if="uploads.favorites.length" class="grid">
      <div
        v-for="u in uploads.favorites"
        :key="u.id"
        role="button"
        class="cell"
        tabindex="0"
        :title="u.filename || u.url"
        :aria-label="`Insert ${u.filename || u.url}`"
        @mousedown.prevent
        @click="pick(u)"
        @keydown.enter.prevent="pick(u)"
        @keydown.space.prevent="pick(u)"
      >
        <img v-if="u.thumbnail_url" :src="u.thumbnail_url" class="art" alt="" loading="lazy" />
        <div v-else class="art art-icon">
          <i class="fa-solid" :class="iconForMime(u.mime)"></i>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useUploadsStore } from '../stores/uploads.js';
import type { UploadItem } from '../stores/uploads.js';
import { iconForMime } from '../utils/uploaders.js';

const props = withDefaults(
  defineProps<{
    // Elements whose taps must NOT dismiss the panel — the toggle button, whose own
    // click handler owns open/close. Without it the document listener closes on
    // pointerdown and the button's click immediately reopens: a toggle that never
    // toggles off. Same contract as VerticalPopover's `ignore`.
    ignore?: readonly (HTMLElement | null)[];
  }>(),
  { ignore: () => [] },
);

const emit = defineEmits<{ close: [] }>();

const uploads = useUploadsStore();
const panelEl = ref<HTMLElement | null>(null);

function pick(u: UploadItem): void {
  // The store's insert bus reaches MessageInput wherever it is mounted, so the
  // picker never needs a reference to the composer. insertUrlAtCaret refocuses the
  // textarea, which is what keeps the iOS keyboard up through the pick.
  uploads.requestInsert(u.url);
  emit('close');
}

function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  if (panelEl.value?.contains(target)) return;
  for (const el of props.ignore) {
    if (el?.contains(target)) return;
  }
  emit('close');
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  // Every open, not once per session: stars set on another device should be here.
  void uploads.loadFavorites();
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
/* Anchored to StatusBar's bottom-right and growing upward, matching
   MircColorPicker — the bar's own content area is one short row, so both of its
   popovers open toward the message list. */
.favorites-picker {
  position: absolute;
  right: var(--space-6);
  bottom: var(--space-3);
  background: var(--bg);
  border: 1px solid var(--border);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  z-index: var(--z-raised);
  /* Wide enough for four 64px thumbs; narrow enough to leave the bar readable
     behind it on a phone. */
  max-width: min(320px, calc(100vw - 2 * var(--space-6)));
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  color: var(--fg-muted);
}
.close {
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
}
.close:hover {
  color: var(--accent);
}
.close:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.note {
  margin: 0;
  max-width: 32ch;
  color: var(--fg-muted);
}
.note.error {
  color: var(--bad);
}
.grid {
  display: grid;
  /* auto-fill so a single starred file sits at thumb size on the left rather than
     stretching across the panel — same reasoning as the uploads browser's grid. */
  grid-template-columns: repeat(auto-fill, 64px);
  gap: var(--space-2);
  /* Roughly four rows before it scrolls. Past that the picker has stopped being
     quick access and the uploads browser is the right tool. */
  max-height: 296px;
  overflow-y: auto;
}
.cell {
  cursor: pointer;
  line-height: 0;
  touch-action: manipulation;
}
.art {
  width: 64px;
  height: 64px;
  object-fit: cover;
  background: var(--bg-soft);
  border: 1px solid var(--border);
}
.art-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  line-height: 1;
}
.cell:hover .art {
  border-color: var(--accent);
}
.cell:focus-visible {
  outline: none;
}
.cell:focus-visible .art {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
