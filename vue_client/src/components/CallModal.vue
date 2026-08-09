<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  The one entry point for voice calls. Opened by the phone button in either
  shell's header (desktop topic bar, mobile header) for a channel or a DM.

  Everything about a call that isn't "in the call right now" lives here, so the
  chat surfaces stay clean: joining/starting is a deliberate confirm (a stray
  click on a header icon must never open your microphone), and the operator
  controls — who may join, guest links — are one layer down instead of stacked
  permanently atop the member list, where they were three op-only affordances
  in a 180px column that everyone else saw as clutter.

  Scoped to the (networkId, target) it was opened for, for its whole lifetime.
  It mounts fresh on every open, so the policy and guest-link reads are plain
  onMounted fetches rather than watchers — no buffer-switch staleness to guard
  and no {immediate:true} setup-order trap (see MemberList.test.ts for the
  crash that pattern caused when it lived in the member list).
-->

<template>
  <AppModal word="call" :title="`call — ${target}`" size="sm" @close="$emit('close')">
    <div class="modal-form">
      <div class="body">
        <p class="status">{{ statusText }}</p>

        <template v-if="isChannel && isOp">
          <label class="policy">
            <span>Who can join</span>
            <select :value="policy" @change="onPolicyChange">
              <option value="none">anyone</option>
              <option value="voice">voiced+</option>
              <option value="halfop">halfop+</option>
              <option value="op">ops only</option>
            </select>
          </label>

          <section class="guests">
            <div class="guest-mint">
              <button
                type="button"
                class="btn-secondary"
                :disabled="guestBusy"
                title="Create a public link a guest can use to join this call without an account (expires in 24h)"
                @click="mintGuestLink"
              >
                <i class="fa-solid fa-link" aria-hidden="true"></i> Guest link
              </button>
              <label
                class="listen-only"
                title="Guests via this link can hear the call but not speak"
              >
                <input v-model="listenOnly" type="checkbox" /> listen-only
              </label>
            </div>
            <div v-if="guestUrl" class="guest-url">
              <input :value="guestUrl" readonly aria-label="Guest call link" @focus="selectAll" />
              <button type="button" class="btn-secondary" @click="copyGuest">
                {{ linkCopy.isCopied('mint') ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <ul v-if="activeLinks.length" class="link-list">
              <li v-for="l in activeLinks" :key="l.token">
                <span class="link-meta" :title="`created by ${l.createdBy ?? 'unknown'}`">
                  {{ l.canPublish ? 'talk' : 'listen' }} · {{ l.useCount }} use{{
                    l.useCount === 1 ? '' : 's'
                  }}
                </span>
                <IconButton
                  :icon="linkCopy.isCopied(l.token) ? 'fa-check' : 'fa-copy'"
                  :label="linkCopy.isCopied(l.token) ? 'Copied' : 'Copy link'"
                  @click="copyLink(l)"
                />
                <IconButton
                  icon="fa-ban"
                  danger
                  label="Revoke — stops new guests from joining; anyone already in the call stays until removed"
                  @click="revokeLink(l)"
                />
              </li>
            </ul>
          </section>
        </template>
      </div>

      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button v-if="inThisCall" type="button" class="btn-primary danger" @click="leave">
          Leave call
        </button>
        <button
          v-else
          type="button"
          class="btn-primary"
          :disabled="inOtherCall || voice.connecting"
          @click="start"
        >
          {{ count > 0 ? 'Join call' : 'Start call' }}
        </button>
      </footer>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import IconButton from './IconButton.vue';
import { useBuffersStore, bufferKey } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useVoiceStore } from '../stores/voice.js';
import { useCallPresenceStore } from '../stores/callPresence.js';
import { useToastsStore } from '../stores/toasts.js';
import { useCopyFeedback } from '../composables/useCopyFeedback.js';
import { canAdminCall } from '../../../shared/voiceModes.js';
import { isChannelTarget } from '../../../shared/channels.js';
import { api } from '../api.js';

const props = defineProps<{ networkId: number; target: string }>();
const emit = defineEmits<{ close: [] }>();

const buffers = useBuffersStore();
const networks = useNetworksStore();
const voice = useVoiceStore();
const callPresence = useCallPresenceStore();

const buffer = computed(() => buffers.byKey(bufferKey(props.networkId, props.target)));
// Prefer the server's own classification; fall back to the shared sigil test
// (all four of #&+!) for a target with no buffer row yet.
const isChannel = computed(() =>
  buffer.value ? buffer.value.kind === 'channel' : isChannelTarget(props.target),
);

const selfNick = computed(() => networks.states[props.networkId]?.nick || null);
const selfModes = computed<string[]>(() => {
  const sn = selfNick.value;
  if (!sn) return [];
  const me = buffer.value?.members?.find((m) => m.nick.toLowerCase() === sn.toLowerCase());
  return Array.isArray(me?.modes) ? me.modes : [];
});
const isOp = computed(() => canAdminCall(selfModes.value));

const count = computed(() => callPresence.countFor(props.networkId, props.target));
const inThisCall = computed(
  () => voice.active && voice.networkId === props.networkId && voice.target === props.target,
);
const inOtherCall = computed(() => (voice.active || voice.connecting) && !inThisCall.value);

const statusText = computed(() => {
  if (inThisCall.value) return "You're in this call.";
  if (inOtherCall.value) return `You're already in a call (${voice.label}). Leave it first.`;
  if (count.value > 0) {
    return `${count.value} ${count.value === 1 ? 'person is' : 'people are'} in this call.`;
  }
  return isChannel.value
    ? 'No one is in this call yet — starting it lets everyone in the channel join.'
    : `Starting a call is the invite: ${props.target} joins from their own client.`;
});

function start() {
  // label = the target; the store mints its own token + room.
  void voice.startCall(props.networkId, props.target, props.target);
  emit('close');
}
function leave() {
  void voice.leave();
  emit('close');
}

// ─── Op join policy (the same shared gate the server enforces) ──────────────
const policy = ref('none');

async function loadPolicy() {
  if (!isChannel.value) return;
  try {
    const r = await api<{ minJoinMode: string }>(
      `/api/voice/policy?networkId=${props.networkId}&target=${encodeURIComponent(props.target)}`,
    );
    policy.value = r.minJoinMode;
  } catch {
    /* leave default */
  }
}

async function onPolicyChange(e: Event) {
  const select = e.target as HTMLSelectElement;
  const minJoinMode = select.value;
  try {
    const r = await api<{ minJoinMode: string }>('/api/voice/policy', {
      method: 'PUT',
      body: { networkId: props.networkId, target: props.target, minJoinMode },
    });
    policy.value = r.minJoinMode;
  } catch (err: unknown) {
    // The DOM select already moved to the rejected choice, and since
    // policy.value didn't change Vue schedules no re-patch — reset the element
    // directly, and say why (an op believing a call is locked when it isn't is
    // the worst silent failure this picker can produce).
    select.value = policy.value;
    useToastsStore().push({
      title: 'Call policy not saved',
      body: err instanceof Error ? err.message : 'the server rejected the change',
      kind: 'warn',
    });
  }
}

// ─── Op guest links (mint / copy / revoke a public capability URL) ──────────
interface GuestLinkRow {
  token: string;
  canPublish: boolean;
  createdBy: string | null;
  useCount: number;
}

/** Build the shareable URL from OUR OWN origin. The server's `url` field is
 *  derived from the request's Origin header, which browsers omit on
 *  same-origin GETs — the listing's URLs would silently carry the internal
 *  Express host. The web client always knows the right origin: its own. */
function linkUrl(token: string): string {
  return `${window.location.origin}/call/${token}`;
}

const guestUrl = ref('');
const guestBusy = ref(false);
const listenOnly = ref(false);
const activeLinks = ref<GuestLinkRow[]>([]);
const linkCopy = useCopyFeedback();

async function refreshLinks() {
  if (!isChannel.value || !isOp.value) {
    activeLinks.value = [];
    return;
  }
  try {
    const r = await api<{ links: GuestLinkRow[] }>(
      `/api/voice/guest-link?networkId=${props.networkId}&target=${encodeURIComponent(props.target)}`,
    );
    activeLinks.value = r.links ?? [];
  } catch {
    /* leave as-is */
  }
}

async function mintGuestLink() {
  guestBusy.value = true;
  try {
    const r = await api<{ token: string }>('/api/voice/guest-link', {
      method: 'POST',
      body: { networkId: props.networkId, target: props.target, canPublish: !listenOnly.value },
    });
    guestUrl.value = linkUrl(r.token);
    void refreshLinks();
  } catch (err: unknown) {
    useToastsStore().push({
      title: 'Could not create guest link',
      body: err instanceof Error ? err.message : 'the server rejected the request',
      kind: 'warn',
    });
  } finally {
    guestBusy.value = false;
  }
}

function copyGuest() {
  if (!guestUrl.value) return;
  void linkCopy.copy(guestUrl.value, 'mint');
}
function copyLink(l: GuestLinkRow) {
  void linkCopy.copy(linkUrl(l.token), l.token);
}
function selectAll(e: FocusEvent) {
  (e.target as HTMLInputElement).select();
}

async function revokeLink(l: GuestLinkRow) {
  try {
    await api(`/api/voice/guest-link/${encodeURIComponent(l.token)}`, { method: 'DELETE' });
    if (guestUrl.value === linkUrl(l.token)) guestUrl.value = '';
    void refreshLinks();
  } catch (err: unknown) {
    useToastsStore().push({
      title: 'Could not revoke guest link',
      body: err instanceof Error ? err.message : 'the server rejected the request',
      kind: 'warn',
    });
  }
}

onMounted(() => {
  void loadPolicy();
  void refreshLinks();
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.status {
  margin: 0;
  color: var(--fg-muted);
}
.policy {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.policy select {
  flex: 1;
  min-width: 0;
}
.guests {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border);
}
.guest-mint {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.listen-only {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  cursor: pointer;
}
.guest-url {
  display: flex;
  gap: var(--space-2);
}
.guest-url input {
  flex: 1;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
}
.link-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.link-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
}
.link-meta {
  flex: 1;
  min-width: 0;
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
