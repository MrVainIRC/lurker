<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Previous-input recall menu — opened by tapping the `>` prompt (see
  MessageInput), it lists the buffer's recent submitted lines so mobile users,
  who have no arrow keys, can still reach their input history (issue #204).
  Picking a row replaces the composer outright, exactly like an Up-arrow
  recall, editable and unsent.

  Thin wrapper over VerticalPopover: it owns the entry list and row look;
  the shared popover owns positioning, dismissal and keyboard navigation.
-->
<template>
  <VerticalPopover
    ref="popover"
    :open="open"
    :rows="rows"
    :anchor="anchor"
    :ignore="[toggleEl]"
    @select="onSelect"
    @close="emit('close')"
  >
    <template #row="{ row }">
      <span class="entry" :title="row">{{ row }}</span>
    </template>
  </VerticalPopover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import VerticalPopover from './VerticalPopover.vue';
import type { PopoverNav } from './popoverNav.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    entries?: readonly string[];
    anchor?: HTMLElement | null;
    toggleEl?: HTMLElement | null;
  }>(),
  {
    open: false,
    entries: () => [],
    anchor: null,
    toggleEl: null,
  },
);

const emit = defineEmits<{
  select: [entry: string];
  close: [];
}>();

const rows = computed<readonly string[]>(() => (props.open ? props.entries.slice(-50) : []));

function onSelect(row: string): void {
  emit('select', row);
}

const popover = ref<PopoverNav | null>(null);
defineExpose({
  moveActive: (delta: number) => popover.value?.moveActive(delta),
  confirmActive: () => popover.value?.confirmActive(),
  hasCandidates: () => popover.value?.hasCandidates() ?? false,
});
</script>

<style scoped>
/* Recalled lines can be long; keep each row to one line and expose the full
   value through the title while the selected value goes into the composer. */
.entry {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
