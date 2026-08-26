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
  <button
    v-if="canReact && message.msgid"
    type="button"
    class="reaction-add"
    title="Add reaction"
    aria-label="Add reaction"
    :aria-expanded="emojiPickerOpen"
    @click.stop="emojiPickerOpen = !emojiPickerOpen"
  >
    <i class="fa-regular fa-face-smile"></i>
  </button>
  <div v-if="emojiPickerOpen" class="emoji-picker" role="group" aria-label="Choose reaction">
    <button
      v-for="emoji in emojiChoices"
      :key="emoji"
      type="button"
      class="emoji-choice"
      :aria-label="`React with ${emoji}`"
      @click.stop="chooseReaction(emoji)"
    >
      {{ emoji }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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
const emojiPickerOpen = ref(false);
const emojiChoices = [
  '😀',
  '😃',
  '😄',
  '😁',
  '😆',
  '😂',
  '🙂',
  '😉',
  '😊',
  '😍',
  '🥰',
  '😎',
  '🤔',
  '😮',
  '😢',
  '😭',
  '😡',
  '👍',
  '👎',
  '❤️',
  '🎉',
  '🚀',
  '👀',
  '🙏',
  '🔥',
  '💯',
  '✅',
  '❌',
  '🤝',
];
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

function chooseReaction(reaction: string): void {
  emojiPickerOpen.value = false;
  toggle(reaction, false);
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
.reaction,
.reaction-add,
.redact-action {
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
.reaction,
.reaction-add {
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
.reaction-add,
.redact-action {
  margin-left: var(--space-1);
  color: var(--fg-muted);
  background: transparent;
}
.redact-action:hover,
.reaction-add:hover {
  color: var(--fg);
}
.emoji-picker {
  display: grid;
  grid-template-columns: repeat(10, max-content);
  gap: var(--space-1);
  margin-top: var(--space-1);
  padding: var(--space-2);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.emoji-choice {
  width: 2em;
  height: 2em;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.emoji-choice:hover,
.emoji-choice:focus-visible {
  background: var(--bg-hover, var(--bg));
}
</style>
