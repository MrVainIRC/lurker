<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <template v-for="(item, i) in items" :key="i">
    <div v-if="item.divider" class="divider" role="separator"></div>
    <div v-else-if="item.heading" class="heading" role="presentation">{{ item.heading }}</div>
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
        <i class="arrow fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
      <div v-if="openIndex === i" class="submenu" role="menu">
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
import { ref } from 'vue';
import type { ContextMenuItem } from '../composables/useContextMenu.js';

defineOptions({ name: 'ContextMenuBranch' });

defineProps<{ items: ContextMenuItem[] }>();
const emit = defineEmits<{ select: [item: ContextMenuItem] }>();
const openIndex = ref<number | null>(null);

function openBranch(index: number): void {
  openIndex.value = index;
}

function toggleBranch(index: number): void {
  openIndex.value = openIndex.value === index ? null : index;
}
</script>

<style scoped>
.branch {
  position: relative;
}
.submenu {
  position: absolute;
  z-index: 1;
  top: calc(-1 * var(--space-2));
  left: calc(100% - var(--space-1));
  min-width: 160px;
  width: max-content;
  padding: var(--space-2) var(--space-1);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
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
  white-space: nowrap;
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
