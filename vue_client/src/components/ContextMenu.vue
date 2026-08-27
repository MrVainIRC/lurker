<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <Teleport to="body">
    <div
      v-if="state.open"
      ref="menuEl"
      class="context-menu"
      :class="{ grid: state.layout === 'grid' }"
      :style="positionStyle"
      role="menu"
      @click.stop
      @contextmenu.prevent
    >
      <ContextMenuBranch :items="state.items" @select="activate" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';
import ContextMenuBranch from './ContextMenuBranch.vue';

const menu = useContextMenu();
const { state } = menu;
const menuEl = ref<HTMLElement | null>(null);
// Position the panel from the raw cursor coords first; once mounted, measure
// actual size and clamp so it stays in the viewport. Grid menus are the
// reaction picker opened from a small action button, so they use that button
// as an anchor and open to its left. Message menus on touch use the explicit
// mobile-edge hint so a tap near the end of a long message does not determine
// the menu's horizontal position.
const clamped = ref({ x: 0, y: 0 });

const positionStyle = computed(() => ({
  left: `${clamped.value.x}px`,
  top: `${clamped.value.y}px`,
}));

watch(
  () => state.open,
  async (isOpen) => {
    if (!isOpen) return;
    clamped.value = { x: state.x, y: state.y };
    await nextTick();
    const el = menuEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 4;
    const anchor =
      state.layout === 'grid' && state.triggerEl ? state.triggerEl.getBoundingClientRect() : null;
    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - rect.height - pad);
    const preferredX = anchor
      ? anchor.left - rect.width - pad
      : state.placement === 'mobile-edge'
        ? window.innerWidth - pad
        : state.x;
    const preferredY = anchor ? anchor.top : state.y;
    const x = Math.min(Math.max(preferredX, pad), maxX);
    const y = Math.min(Math.max(preferredY, pad), maxY);
    clamped.value = { x, y };
  },
);

function activate(item: ContextMenuItem): void {
  if (item.disabled) return;
  try {
    item.onClick?.();
  } finally {
    menu.close();
  }
}

function onWindowPointerDown(e: PointerEvent): void {
  if (!state.open) return;
  if (menuEl.value && menuEl.value.contains(e.target as Node)) return;
  // Leave a pointerdown on the opening trigger alone: its own click handler
  // fires next and re-calls open() with the same triggerEl, which toggles the
  // menu closed (see useContextMenu). Closing here would race that click and
  // reopen the menu — pointerdown can't cancel the click that follows.
  if (state.triggerEl && state.triggerEl.contains(e.target as Node)) return;
  menu.close();
}
function onWindowKey(e: KeyboardEvent): void {
  if (state.open && e.key === 'Escape') menu.close();
}
// Close on a user-driven scroll gesture (wheel / touch drag) — the menu is
// pinned to fixed cursor/anchor coords, so once the user scrolls the content
// underneath it, it would float detached. We deliberately listen for the
// *gesture* (wheel/touchmove), NOT the 'scroll' event: a busy channel's
// auto-scroll on each new message fires 'scroll' programmatically and would
// otherwise slam the menu shut mid-interaction. A gesture that starts inside the
// menu itself (e.g. scrolling a long menu) is ignored.
function onWindowUserScroll(e: Event): void {
  if (!state.open) return;
  // e.target on a captured wheel/touchmove is normally the element under the
  // pointer, but guard the non-Node case (window/document) so contains() can't
  // throw. A non-Node target is never inside the menu, so fall through to close.
  const t = e.target;
  if (t instanceof Node && menuEl.value?.contains(t)) return;
  menu.close();
}
function onWindowResize(): void {
  if (state.open) menu.close();
}

// Attaching listeners only while open avoids paying for them on every scroll
// during typical app use. Capture-phase pointerdown — not mousedown — so the
// "tap a different message row" case still closes the menu on iOS: in the
// sticky-:hover mode that powers the row → dots → menu UX, a tap on a new
// row often doesn't synthesize a mousedown at the document level (iOS
// consumes that first tap to transfer the hover state), but a pointerdown
// always fires. Mouse and stylus paths land here too — pointerdown precedes
// mousedown for them with the same target and contains-checks behavior.
watch(
  () => state.open,
  (isOpen) => {
    if (isOpen) {
      window.addEventListener('pointerdown', onWindowPointerDown, true);
      window.addEventListener('keydown', onWindowKey);
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('wheel', onWindowUserScroll, { capture: true, passive: true });
      window.addEventListener('touchmove', onWindowUserScroll, { capture: true, passive: true });
    } else {
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      window.removeEventListener('keydown', onWindowKey);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('wheel', onWindowUserScroll, true);
      window.removeEventListener('touchmove', onWindowUserScroll, true);
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true);
  window.removeEventListener('keydown', onWindowKey);
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('wheel', onWindowUserScroll, true);
  window.removeEventListener('touchmove', onWindowUserScroll, true);
});
</script>

<style scoped>
.context-menu {
  position: fixed;
  z-index: var(--z-menu);
  box-sizing: border-box;
  min-width: 160px;
  max-width: calc(100vw - 8px);
  max-height: calc(100vh - 8px);
  overflow: auto;
  /* `width: auto` on a position:fixed element near the right edge gets
     shrink-wrapped to the available viewport space, which wraps long labels
     before the clamp watcher gets a chance to shift the menu left. `max-content`
     ignores the viewport constraint and sizes to the widest unwrapped item, so
     the clamp logic then sees the real width and repositions correctly. */
  width: max-content;
  /* Same floating-card chrome as the per-message action bar (.row-actions in
     MessageList.vue): a --bg surface with a real 1px border, rounded corners,
     and the lighter drop shadow — so both popups read as the same family of
     floating surface. The vertical padding gives the list breathing room above
     the first row and below the last; the small horizontal padding insets the
     rounded item-hover chips from the card edge (Slack-style roomy menu). */
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  padding: var(--space-2) var(--space-1);
  color: var(--fg);
  user-select: none;
}
.context-menu.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-1);
  min-width: 0;
  width: min(16rem, calc(100vw - 8px));
  padding: var(--space-2);
}
.context-menu.grid :deep(.item) {
  justify-content: center;
  width: 100%;
  height: 2.25rem;
  padding: 0;
}
.context-menu.grid :deep(.item .icon),
.context-menu.grid :deep(.item .arrow) {
  display: none;
}
.context-menu.grid :deep(.divider) {
  grid-column: 1 / -1;
  width: auto;
}
.context-menu.grid :deep(.divider) + .item {
  grid-column: 1 / -1;
  justify-content: flex-start;
  width: auto;
  height: auto;
  padding: var(--space-3) var(--space-4);
}
.context-menu.grid :deep(.input-item) {
  grid-column: 1 / -1;
  padding: var(--space-2) var(--space-1);
}
.context-menu.grid :deep(.menu-input) {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  color: var(--fg);
  font: inherit;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
}
.context-menu.grid :deep(.menu-input:focus) {
  border-color: var(--accent);
}
.item {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  /* Roomy padding (Slack-style), kept asymmetric — more on the right so the
     label has trailing breathing room from the menu edge. */
  padding: var(--space-4) var(--space-10) var(--space-4) var(--space-7);
  background: none;
  border: none;
  /* Round the hover/focus fill into a chip inset within the padded card,
     matching the action bar's rounded row buttons. */
  border-radius: var(--radius-sm);
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.item:hover:not(:disabled) {
  /* Neutral --bg-soft fill on hover, matching the action bar's row buttons:
     the row quiets to a soft background and the icon (below) pops to accent,
     rather than washing the whole row in accent. */
  background: var(--bg-soft);
}
.item:hover:not(:disabled) .icon {
  /* Brighten the muted icon to --fg on hover, matching the action bar's row
     buttons — accent is reserved for active/on states, not plain hover. */
  color: var(--fg);
}
.item:disabled {
  color: var(--fg-muted);
  cursor: default;
}
/* FontAwesome solid glyphs are biased toward the top of their em box (bell,
   thumbtack, etc. have visual weight near the top), so geometric centering
   reads as the icon sitting slightly high relative to the label's x-height.
   A 1px downward nudge optically aligns the icon body with the text. */
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  color: var(--fg-muted);
  transform: translateY(1px);
}
.heading {
  /* A muted group label above a radio group (e.g. "Notifications"). Uppercased
     with letter-spacing so it reads as a header without changing font-size (the
     app keeps a single type size — hierarchy comes from color/weight/spacing). */
  padding: var(--space-3) var(--space-7) var(--space-2);
  color: var(--fg-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  user-select: none;
}
.divider {
  height: 1px;
  /* --border cuts a clean line through the --bg card surface (the old --bg
     divider would now vanish into the matching background). The vertical margin
     sets the rule apart from the rows above and below it (e.g. between Mute
     Channel and Close Channel) rather than letting them sit flush against it. */
  background: var(--border);
  margin: var(--space-2) 0;
}
</style>
