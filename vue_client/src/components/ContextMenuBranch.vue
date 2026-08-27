<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <template v-for="(item, i) in items" :key="i">
    <div v-if="item.divider" class="divider" role="separator"></div>
    <div v-else-if="item.heading" class="heading" role="presentation">{{ item.heading }}</div>
    <div v-else-if="item.input" class="input-item" role="none" @click.stop>
      <input
        type="text"
        class="menu-input"
        :placeholder="item.input.placeholder"
        :aria-label="item.input.ariaLabel || item.input.placeholder || 'Menu input'"
        :maxlength="item.input.maxLength"
        autocomplete="off"
        spellcheck="false"
        autofocus
        @keydown.enter.prevent="submitInput(item, $event)"
      />
    </div>
    <div v-else-if="item.children?.length" class="branch" @mouseenter="openBranch(i)">
      <button
        type="button"
        class="item"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="openIndex === i"
        :disabled="item.disabled"
        @focus="openBranch(i)"
        @click="toggleBranch(i)"
      >
        <i v-if="item.icon" :class="['icon', item.icon]" aria-hidden="true"></i>
        <span class="label">{{ item.label }}</span>
        <i
          class="arrow fa-solid"
          :class="
            openIndex === i && submenuSide === 'left' ? 'fa-chevron-left' : 'fa-chevron-right'
          "
          aria-hidden="true"
        ></i>
      </button>
      <div
        v-if="openIndex === i"
        class="submenu"
        :class="{ grid: item.layout === 'grid' }"
        :style="submenuStyle"
        :ref="(el) => setSubmenuElement(i, el)"
        role="menu"
      >
        <ContextMenuBranch :items="item.children" @select="emit('select', $event)" />
      </div>
    </div>
    <button
      v-else
      type="button"
      class="item"
      role="menuitem"
      :disabled="item.disabled"
      @click="emit('select', item)"
    >
      <i v-if="item.icon" :class="['icon', item.icon]" aria-hidden="true"></i>
      <span class="label">{{ item.label }}</span>
    </button>
  </template>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { ContextMenuItem } from '../composables/useContextMenu.js';

defineOptions({ name: 'ContextMenuBranch' });

const props = defineProps<{ items: ContextMenuItem[] }>();
const emit = defineEmits<{ select: [item: ContextMenuItem] }>();
const openIndex = ref<number | null>(null);
const submenuEl = ref<HTMLElement | null>(null);
const submenuStyle = ref<Record<string, string>>({ visibility: 'hidden' });
const submenuSide = ref<'left' | 'right'>('right');

function openBranch(index: number): void {
  openIndex.value = index;
  submenuEl.value = null;
  submenuSide.value = 'right';
  submenuStyle.value = { visibility: 'hidden' };
  void nextTick(positionSubmenu);
}

function toggleBranch(index: number): void {
  openIndex.value = openIndex.value === index ? null : index;
  submenuEl.value = null;
  submenuSide.value = 'right';
  submenuStyle.value = { visibility: 'hidden' };
  if (openIndex.value !== null) void nextTick(positionSubmenu);
}

function setSubmenuElement(index: number, value: unknown): void {
  if (index !== openIndex.value) return;
  submenuEl.value = value instanceof HTMLElement ? value : null;
}

async function positionSubmenu(): Promise<void> {
  await nextTick();
  const el = submenuEl.value;
  const branch = el?.parentElement;
  if (!el || !branch || openIndex.value === null) return;

  const menuRect = el.getBoundingClientRect();
  const branchRect = branch.getBoundingClientRect();
  const pad = 4;
  const gap = 4;
  const rightX = branchRect.right - gap;
  const leftX = branchRect.left + gap - menuRect.width;
  const rightFits = rightX + menuRect.width <= window.innerWidth - pad;
  const leftFits = leftX >= pad;
  const item = props.items[openIndex.value];
  const forceLeft = item?.layout === 'grid';
  const leftSpace = branchRect.left - pad;
  const rightSpace = window.innerWidth - pad - branchRect.right;
  // Reaction grids must open left from the action menu. For every other
  // submenu, use the normal right side when it fits; when neither side fits,
  // choose the side with more room. The old `!leftFits ? rightX` fallback
  // selected the right side even when both sides overflowed, which put a
  // mobile reaction menu back against the viewport edge.
  const preferredX = forceLeft
    ? leftX
    : rightFits
      ? rightX
      : leftFits
        ? leftX
        : leftSpace >= rightSpace
          ? leftX
          : rightX;
  submenuSide.value = preferredX === leftX ? 'left' : 'right';
  const maxX = Math.max(pad, window.innerWidth - menuRect.width - pad);
  const maxY = Math.max(pad, window.innerHeight - menuRect.height - pad);
  const x = Math.min(Math.max(preferredX, pad), maxX);
  const y = Math.min(Math.max(branchRect.top - 4, pad), maxY);
  submenuStyle.value = {
    left: `${x}px`,
    top: `${y}px`,
    visibility: 'visible',
  };
}

function submitInput(item: ContextMenuItem, event: KeyboardEvent): void {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const value = input.value.trim();
  if (!value) return;
  item.input?.onSubmit(value);
  emit('select', item);
}
</script>

<style scoped>
.branch {
  position: relative;
}
.submenu {
  position: fixed;
  z-index: 1;
  box-sizing: border-box;
  min-width: min(160px, calc(100vw - 8px));
  max-width: calc(100vw - 8px);
  max-height: calc(100vh - 8px);
  overflow: auto;
  width: max-content;
  padding: var(--space-2) var(--space-1);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
}
.submenu.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-1);
  min-width: 0;
  width: min(16rem, calc(100vw - 8px));
  padding: var(--space-2);
}
.submenu.grid :deep(.item) {
  justify-content: center;
  width: 100%;
  height: 2.25rem;
  padding: 0;
}
.submenu.grid :deep(.item .icon),
.submenu.grid :deep(.item .arrow) {
  display: none;
}
.submenu.grid :deep(.divider) {
  grid-column: 1 / -1;
  width: auto;
}
.submenu.grid :deep(.divider) + .item {
  grid-column: 1 / -1;
  justify-content: flex-start;
  width: auto;
  height: auto;
  padding: var(--space-3) var(--space-4);
}
.input-item {
  grid-column: 1 / -1;
  min-width: 0;
  max-width: 100%;
  padding: var(--space-2) var(--space-1);
}
.menu-input {
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
.menu-input:focus {
  border-color: var(--accent);
}
.item {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  padding: var(--space-4) var(--space-7);
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: normal;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.item:hover:not(:disabled),
.item:focus-visible:not(:disabled) {
  background: var(--bg-soft);
  outline: none;
}
.item:disabled {
  color: var(--fg-muted);
  cursor: default;
}
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  color: var(--fg-muted);
}
.arrow {
  margin-left: auto;
  color: var(--fg-muted);
}
.divider {
  height: 1px;
  margin: var(--space-2) 0;
  background: var(--border);
}
.heading {
  padding: var(--space-3) var(--space-7) var(--space-2);
  color: var(--fg-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
</style>
