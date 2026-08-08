<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Public guest voice-call page (/call/:token). Someone without an account opens
  the capability link an op minted, picks a display name, and joins the call.
  It exchanges the link token for a room-scoped LiveKit token and connects via
  the shared voice store; the global CallBar provides the in-call controls.
-->

<template>
  <div class="guest-call">
    <div class="card">
      <h1><i class="fa-solid fa-phone" aria-hidden="true"></i> Join voice call</h1>

      <!-- config arrives async and defaults voice OFF — don't flash
           "unavailable" at a legitimate guest while the fetch is in flight,
           and don't dead-end them if that one fetch fails (this page has no
           router navigations to retrigger the store's retry path). -->
      <template v-if="!config.checked">
        <p v-if="!bootFailed" class="hint">Loading…</p>
        <template v-else>
          <p class="err">Couldn't reach the server.</p>
          <button class="btn-secondary" type="button" @click="boot">Retry</button>
        </template>
      </template>

      <p v-else-if="!config.voiceEnabled" class="err">Voice calling isn't available here.</p>

      <template v-else-if="!voice.active && !voice.connecting">
        <p class="hint">You've been invited to a voice call. Pick a name to join.</p>
        <input
          v-model="name"
          class="name"
          placeholder="Your name"
          maxlength="24"
          spellcheck="false"
          @keyup.enter="join"
        />
        <button
          class="btn-primary join"
          type="button"
          :disabled="!name.trim() || joining"
          @click="join"
        >
          {{ joining ? 'Joining…' : 'Join call' }}
        </button>
        <p v-if="error" class="err">{{ error }}</p>
      </template>

      <p v-else-if="voice.connecting" class="hint">Connecting…</p>

      <template v-else>
        <p class="ok"><i class="fa-solid fa-check" aria-hidden="true"></i> You're in the call.</p>
        <p class="hint">
          {{
            listenOnly
              ? 'This link is listen-only — you can hear the call but not speak.'
              : 'Use the call controls in the corner to mute or leave.'
          }}
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useVoiceStore } from '../stores/voice.js';
import { useConfigStore } from '../stores/config.js';
import { api } from '../api.js';

const route = useRoute();
const voice = useVoiceStore();
const config = useConfigStore();

const token = String(route.params.token || '');
const name = ref('');
const joining = ref(false);
const error = ref('');
const listenOnly = ref(false);
const bootFailed = ref(false);

async function boot() {
  bootFailed.value = false;
  await config.fetch().catch(() => {});
  if (!config.checked) bootFailed.value = true;
}
onMounted(() => {
  if (!config.checked) void boot();
});

async function join() {
  if (!name.value.trim() || joining.value) return;
  joining.value = true;
  error.value = '';
  try {
    const r = await api<{ token: string; url: string; canPublish: boolean }>(
      '/api/voice/guest-token',
      { method: 'POST', body: { token, name: name.value.trim() } },
    );
    listenOnly.value = r.canPublish === false;
    await voice.connectWithToken(r.url, r.token, 'Guest call', {
      guest: true,
      canPublish: r.canPublish,
    });
    // connectWithToken reports its failures through the store, not a throw.
    if (voice.error) error.value = voice.error;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'could not join the call';
  } finally {
    joining.value = false;
  }
}
</script>

<style scoped>
.guest-call {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: var(--bg);
  color: var(--fg);
}
.card {
  width: 100%;
  max-width: 360px;
  padding: var(--space-8);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  text-align: center;
}
.card h1 {
  font-size: inherit;
  font-weight: 600;
  margin: 0 0 var(--space-5);
}
.hint {
  color: var(--fg-muted);
  margin: 0 0 var(--space-5);
}
.name {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-5);
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
}
.join {
  width: 100%;
}
.ok {
  color: var(--good);
  font-weight: 600;
  margin: 0 0 var(--space-3);
}
.err {
  color: var(--bad);
  margin: var(--space-3) 0 0;
}
</style>
