<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="message.redacted" class="message-redacted">
    [message redacted]<span v-if="message.redactionReason"> — {{ message.redactionReason }}</span>
  </div>
  <button
    v-if="message.replyTo"
    type="button"
    class="reply-reference"
    :title="parent ? 'Jump to original message' : 'Original message unavailable'"
    @click.stop="jumpToParent"
  >
    ↳ <strong>{{ parent?.nick || 'Original message' }}</strong
    ><template v-if="parent">: {{ preview(parent.text) }}</template
    ><template v-else> — original message unavailable</template>
  </button>
  <div v-if="reactions.length && canReact" class="reactions" aria-label="Reactions">
    <button
      v-for="entry in reactions"
      :key="entry.reaction"
      type="button"
      class="reaction"
      :class="{ mine: entry.actors.includes(selfActor) }"
      :title="entry.actors.join(', ')"
      @click.stop="toggle(entry.reaction, entry.actors.includes(selfActor))"
    >
      {{ entry.reaction }} {{ entry.actors.length }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useBuffersStore, type BufferMessage, type ReactionEntry } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { socketSend } from '../composables/useSocket.js';

const props = defineProps<{
  message: BufferMessage & {
    msgid?: string;
    replyTo?: string;
    redacted?: boolean;
    redactionReason?: string | null;
    reactions?: ReactionEntry[];
  };
  networkId: number;
  target: string;
}>();

const buffers = useBuffersStore();
const networks = useNetworksStore();
const buffer = computed(() => buffers.findByTarget(props.networkId, props.target));
const features = computed(() => networks.states[props.networkId]?.negotiatedFeatures || {});
const canReact = computed(() => !!features.value.reactions && !!features.value.messageTags);
const selfActor = computed(() => networks.states[props.networkId]?.nick || '');
const parent = computed(() => {
  if (!props.message.replyTo) return null;
  return buffer.value?.messages.find((message) => message.msgid === props.message.replyTo) as
    | (BufferMessage & { nick?: string; text?: string })
    | undefined;
});
const reactions = computed(() => {
  const grouped = new Map<string, string[]>();
  for (const entry of props.message.reactions || []) {
    const actors = grouped.get(entry.reaction) || [];
    if (!actors.includes(entry.actor)) actors.push(entry.actor);
    grouped.set(entry.reaction, actors);
  }
  return [...grouped].map(([reaction, actors]) => ({ reaction, actors }));
});

function preview(text: unknown): string {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > 120 ? `${value.slice(0, 117)}…` : value;
}

function toggle(reaction: string, removed: boolean): void {
  if (!props.message.msgid || !canReact.value) return;
  socketSend({
    type: removed ? 'unreact' : 'react',
    networkId: props.networkId,
    target: props.target,
    msgid: props.message.msgid,
    reaction,
  });
}

function jumpToParent(): void {
  const id = parent.value?.id;
  if (id == null) return;
  document.querySelector(`[data-msg-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
}
</script>

<style scoped>
.reply-reference,
.reaction {
  font: inherit;
  border: 0;
  cursor: pointer;
}
.reply-reference {
  display: block;
  max-width: 100%;
  padding: 0;
  overflow: hidden;
  color: var(--fg-muted);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: none;
}
.reply-reference:hover {
  color: var(--fg);
}
.message-redacted {
  color: var(--fg-muted);
  font-style: italic;
}
.reactions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.reaction {
  padding: 0 var(--space-2);
  color: var(--fg-muted);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.reaction.mine {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
