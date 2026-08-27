<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="networks.states[networkId]" class="metadata-editor">
    <strong>Profile</strong>
    <div class="feature-status" aria-label="IRCv3 features">
      <span
        v-for="entry in featureEntries"
        :key="entry.key"
        class="feature-chip"
        :class="{ supported: entry.supported }"
        :title="entry.supported ? 'Negotiated' : 'Not negotiated'"
      >
        <i :class="entry.supported ? 'fa-solid fa-check' : 'fa-solid fa-minus'"></i>
        {{ entry.label }}
      </span>
    </div>
    <div v-if="features.metadata" class="metadata-fields">
      <label v-for="key in metadataKeys" :key="key">
        <span>{{ key }}</span>
        <input v-model="values[key]" :placeholder="metadataValue(key)" />
      </label>
    </div>
    <label v-if="features.setname">
      <span>Real name</span>
      <input v-model="realname" placeholder="Real name" />
    </label>
    <button v-if="features.metadata || features.setname" type="button" @click="save">
      Save profile
    </button>
    <span v-if="message" class="save-message">{{ message }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { socketSend } from '../composables/useSocket.js';

const props = defineProps<{ networkId: number }>();
const networks = useNetworksStore();
const metadataKeys = ['avatar', 'display-name', 'pronouns', 'status', 'homepage', 'color'];
const values = reactive<Record<string, string>>(
  Object.fromEntries(metadataKeys.map((key) => [key, ''])),
);
const savedValues = reactive<Record<string, string>>(
  Object.fromEntries(metadataKeys.map((key) => [key, ''])),
);
const realname = ref('');
const message = ref('');
const network = computed(() => networks.networkById(props.networkId));
const features = computed(() => networks.states[props.networkId]?.negotiatedFeatures || {});
const featureLabels: Record<string, string> = {
  reply: 'Replies',
  reactions: 'Reactions',
  redaction: 'Redaction',
  metadata: 'Metadata',
  setname: 'SETNAME',
  standardReplies: 'Structured errors',
  labeledResponse: 'Labels',
  botMode: 'Bot mode',
  networkIcon: 'Network icon',
};
const featureEntries = computed(() =>
  Object.entries(featureLabels).map(([key, label]) => ({
    key,
    label,
    supported: !!features.value[key],
  })),
);
const ownMetadata = computed(() => {
  const state = networks.states[props.networkId];
  const nick = state?.nick || '';
  const rows = state?.metadata || {};
  const target =
    (rows['*'] ? '*' : undefined) ||
    Object.keys(rows).find((key) => key.toLowerCase() === nick.toLowerCase());
  return target ? rows[target] : [];
});

function metadataValue(key: string): string {
  return ownMetadata.value.find((entry) => entry.key === key)?.value || '';
}

watch(
  ownMetadata,
  () => {
    for (const key of metadataKeys) {
      const value = metadataValue(key);
      values[key] = value;
      savedValues[key] = value;
    }
  },
  { immediate: true },
);

watch(
  network,
  (value) => {
    if (!realname.value && typeof value?.realname === 'string') realname.value = value.realname;
  },
  { immediate: true },
);

function save(): void {
  let sent = 0;
  // Snapshot only changed values before sending. A server echo can update
  // ownMetadata between two commands and the watcher would otherwise replace
  // the still-unsent fields with their old values.
  const pendingMetadata = metadataKeys
    .map((key) => ({ key, value: values[key].trim() }))
    .filter(({ key, value }) => value !== savedValues[key]);
  if (features.value.metadata) {
    for (const { key, value } of pendingMetadata) {
      // draft/metadata-2 uses SET <key> [:value] for both writing and
      // removing one key. CLEAR has no key parameter and would clear the
      // entire profile, so it must not be used for an empty field.
      const command = 'SET';
      const params = value ? [key, value] : [key];
      if (
        socketSend({
          type: 'metadata',
          networkId: props.networkId,
          target: '*',
          command,
          params,
        })
      ) {
        sent += 1;
        savedValues[key] = value;
      }
    }
  }
  const realnameValue = realname.value.trim();
  if (
    features.value.setname &&
    realnameValue &&
    socketSend({ type: 'setname', networkId: props.networkId, realname: realnameValue })
  )
    sent += 1;
  message.value = sent
    ? 'Profile update sent.'
    : features.value.metadata || features.value.setname
      ? 'No profile changes to send.'
      : 'This network does not support profile updates.';
}
</script>

<style scoped>
.metadata-editor {
  grid-column: 1 / -1;
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  border-top: 1px solid var(--border);
}
.metadata-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12em, 1fr));
  gap: var(--space-3);
}
.feature-status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.feature-chip {
  padding: var(--space-1) var(--space-2);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  opacity: 0.65;
}
.feature-chip.supported {
  color: var(--accent);
  opacity: 1;
}
.metadata-editor label {
  display: grid;
  gap: var(--space-1);
  color: var(--fg-muted);
}
.metadata-editor input {
  min-width: 0;
  padding: var(--space-2);
  color: var(--fg);
  font: inherit;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.metadata-editor button {
  justify-self: start;
  padding: var(--space-2) var(--space-4);
  color: var(--accent);
  font: inherit;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.save-message {
  color: var(--fg-muted);
}
</style>
