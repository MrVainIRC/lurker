<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="react" title="Custom reaction" size="md" @close="$emit('close')">
    <form class="modal-form" @submit.prevent="submit">
      <div class="body">
        <label class="field">
          <span>Reaction text</span>
          <input
            ref="inputEl"
            v-model="reaction"
            type="text"
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. +1 or well done"
          />
        </label>
        <p class="hint">Use any text up to 64 characters. It will be sent as the reaction.</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="!reaction.trim()">React</button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';

const emit = defineEmits<{
  close: [];
  submit: [reaction: string];
}>();

const reaction = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function submit(): void {
  const value = reaction.value.trim();
  if (value) emit('submit', value);
}

onMounted(() => {
  setTimeout(() => inputEl.value?.focus(), 0);
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding-bottom: var(--space-7);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.hint {
  margin: 0;
  color: var(--fg-muted);
}
</style>
