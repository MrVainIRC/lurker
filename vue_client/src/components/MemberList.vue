<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="members">
    <div v-if="canCall" class="members-head">
      <button
        type="button"
        class="call-btn"
        :disabled="voice.connecting || voice.active"
        :title="inThisCall ? 'You are in this call' : 'Start or join a voice call in this channel'"
        @click="startCall"
      >
        <i class="fa-solid fa-phone" aria-hidden="true"></i>
        <span>{{ callBtnLabel }}</span>
      </button>
      <label v-if="isOp" class="call-policy" title="Who may join this channel's call">
        <span>Join</span>
        <select :value="policy" @change="onPolicyChange">
          <option value="none">anyone</option>
          <option value="voice">voiced+</option>
          <option value="halfop">halfop+</option>
          <option value="op">ops only</option>
        </select>
      </label>
      <div v-if="isOp" class="guest-links">
        <div class="guest-mint">
          <button
            type="button"
            class="guest-btn"
            :disabled="guestBusy"
            title="Create a public link a guest can use to join this channel's call without an account (expires in 24h)"
            @click="mintGuestLink"
          >
            <i class="fa-solid fa-link" aria-hidden="true"></i> Guest link
          </button>
          <label class="listen-only" title="Guests via this link can hear the call but not speak">
            <input v-model="listenOnly" type="checkbox" /> listen-only
          </label>
        </div>
        <div v-if="guestUrl" class="guest-url">
          <input :value="guestUrl" readonly aria-label="Guest call link" @focus="selectAll" />
          <button type="button" @click="copyGuest">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <ul v-if="activeLinks.length" class="link-list">
          <li v-for="l in activeLinks" :key="l.token">
            <span class="link-meta" :title="`created by ${l.createdBy ?? 'unknown'}`">
              {{ l.canPublish ? 'talk' : 'listen' }} · {{ l.useCount }} use{{
                l.useCount === 1 ? '' : 's'
              }}
            </span>
            <IconButton icon="fa-copy" label="Copy link" @click="copyLink(l)" />
            <IconButton
              icon="fa-ban"
              danger
              label="Revoke — stops new guests from joining; anyone already in the call stays until removed"
              @click="revokeLink(l)"
            />
          </li>
        </ul>
      </div>
    </div>
    <ul ref="listEl">
      <li
        v-for="m in sorted"
        :key="nickOf(m)"
        :class="liClass(m)"
        @click="onRowClick($event, m)"
        @contextmenu.prevent="onRowContextMenu($event, m)"
      >
        <span class="prefix">{{ prefixOf(m) }}</span>
        <span class="nick" :style="nickStyle(m)" :title="nickOf(m)">{{ nickOf(m) }}</span>
        <button
          type="button"
          class="row-actions"
          title="Actions"
          aria-label="Member actions"
          @click.stop="onActionsClick($event, m)"
          @contextmenu.stop.prevent
        >
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
      </li>
    </ul>
    <IgnoreModal
      v-if="modalMember"
      :nick="nickOf(modalMember)"
      :user="userOf(modalMember)"
      :host="hostOf(modalMember)"
      :network-id="buffer?.networkId ?? null"
      @close="modalMember = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore, type BufferMember } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useMemberActions } from '../composables/useMemberActions.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useConfigStore } from '../stores/config.js';
import { useVoiceStore } from '../stores/voice.js';
import { useCallPresenceStore } from '../stores/callPresence.js';
import { useToastsStore } from '../stores/toasts.js';
import { canAdminCall } from '../../../shared/voiceModes.js';
import { api } from '../api.js';
import {
  PREFIX_ORDER,
  prefixOf as modePrefixOf,
  prefixClass as modePrefixClass,
} from '../utils/memberPrefix.js';
import IgnoreModal from './IgnoreModal.vue';
import IconButton from './IconButton.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();
const memberActions = useMemberActions();
const ignores = useIgnoresStore();
const modalMember = ref<BufferMember | null>(null);
const listEl = ref<HTMLElement | null>(null);

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const members = computed((): BufferMember[] => buffer.value?.members || []);

// ─── Voice call (channels only, and only when the instance offers it) ────────
const config = useConfigStore();
const voice = useVoiceStore();
const canCall = computed(
  () => config.voiceEnabled && buffer.value?.kind === 'channel' && buffer.value?.networkId != null,
);
const inThisCall = computed(
  () =>
    voice.active &&
    voice.networkId === (buffer.value?.networkId ?? null) &&
    voice.target === buffer.value?.target,
);
function startCall() {
  const b = buffer.value;
  if (!b || b.networkId == null) return;
  // label = the channel target; the store mints its own token + room.
  void voice.startCall(b.networkId, b.target, b.target);
}

// "Join call (N)" badge for a call already in progress (webhook-driven counts,
// hydrated on connect — see stores/callPresence).
const callPresence = useCallPresenceStore();
const callCount = computed(() => {
  const b = buffer.value;
  return b?.networkId != null ? callPresence.countFor(b.networkId, b.target) : 0;
});
const callBtnLabel = computed(() => {
  if (inThisCall.value) return 'In call';
  if (callCount.value > 0) return `Join call (${callCount.value})`;
  return 'Call';
});

// ─── Op join policy (the same shared gate the server enforces) ──────────────
const isOp = computed(() => canAdminCall(selfModes.value));

const policy = ref('none');

// Load the channel's join policy whenever the active channel changes — or when
// voiceEnabled flips true, because the config fetch is async and can resolve
// AFTER the immediate fire (a deep-linked cold load would otherwise show
// 'anyone' for a locked channel and never retry).
watch(
  [buffer, () => config.voiceEnabled],
  async ([b]) => {
    policy.value = 'none';
    if (!config.voiceEnabled || !b || b.kind !== 'channel' || b.networkId == null) return;
    try {
      const r = await api<{ minJoinMode: string }>(
        `/api/voice/policy?networkId=${b.networkId}&target=${encodeURIComponent(b.target)}`,
      );
      // Staleness guard: a slow response for the PREVIOUS channel must not
      // overwrite the picker after a switch.
      if (buffer.value !== b) return;
      policy.value = r.minJoinMode;
    } catch {
      /* leave default */
    }
  },
  { immediate: true },
);

// ─── Op guest links (mint / copy / revoke a public capability URL) ──────────
interface GuestLinkRow {
  token: string;
  url: string;
  canPublish: boolean;
  createdBy: string | null;
  useCount: number;
}

const guestUrl = ref('');
const copied = ref(false);
const guestBusy = ref(false);
const listenOnly = ref(false);
const activeLinks = ref<GuestLinkRow[]>([]);

async function refreshLinks(b = buffer.value) {
  if (!config.voiceEnabled || !isOp.value || !b || b.kind !== 'channel' || b.networkId == null) {
    activeLinks.value = [];
    return;
  }
  try {
    const r = await api<{ links: GuestLinkRow[] }>(
      `/api/voice/guest-link?networkId=${b.networkId}&target=${encodeURIComponent(b.target)}`,
    );
    if (buffer.value !== b) return; // stale response for a previous channel
    activeLinks.value = r.links ?? [];
  } catch {
    /* leave as-is */
  }
}

watch(
  [buffer, isOp, () => config.voiceEnabled],
  ([b]) => {
    guestUrl.value = '';
    copied.value = false;
    activeLinks.value = [];
    void refreshLinks(b);
  },
  { immediate: true },
);

async function mintGuestLink() {
  const b = buffer.value;
  if (!b || b.networkId == null) return;
  guestBusy.value = true;
  copied.value = false;
  try {
    const r = await api<{ url: string }>('/api/voice/guest-link', {
      method: 'POST',
      body: { networkId: b.networkId, target: b.target, canPublish: !listenOnly.value },
    });
    guestUrl.value = r.url;
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
  void navigator.clipboard?.writeText(guestUrl.value);
  copied.value = true;
}
function copyLink(l: GuestLinkRow) {
  void navigator.clipboard?.writeText(l.url);
}
function selectAll(e: FocusEvent) {
  (e.target as HTMLInputElement).select();
}

async function revokeLink(l: GuestLinkRow) {
  try {
    await api(`/api/voice/guest-link/${encodeURIComponent(l.token)}`, { method: 'DELETE' });
    if (guestUrl.value === l.url) guestUrl.value = '';
    void refreshLinks();
  } catch (err: unknown) {
    useToastsStore().push({
      title: 'Could not revoke guest link',
      body: err instanceof Error ? err.message : 'the server rejected the request',
      kind: 'warn',
    });
  }
}

async function onPolicyChange(e: Event) {
  const b = buffer.value;
  const select = e.target as HTMLSelectElement;
  if (!b || b.networkId == null) return;
  const minJoinMode = select.value;
  try {
    const r = await api<{ minJoinMode: string }>('/api/voice/policy', {
      method: 'PUT',
      body: { networkId: b.networkId, target: b.target, minJoinMode },
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
const selfNick = computed(() => {
  const b = buffer.value;
  if (!b || b.networkId == null) return null;
  return networks.states[b.networkId]?.nick || null;
});
// The current user's own modes in this channel, used to gate the operator
// actions in the member context menu.
const selfModes = computed<string[]>(() => {
  const sn = selfNick.value;
  if (!sn) return [];
  const me = members.value.find((m) => nickOf(m).toLowerCase() === sn.toLowerCase());
  return me && Array.isArray(me.modes) ? me.modes : [];
});

watch(
  () => networks.activeKey,
  () => {
    if (listEl.value) listEl.value.scrollTop = 0;
  },
  { flush: 'post' },
);

function isSelf(m: BufferMember): boolean {
  const sn = selfNick.value;
  return !!sn && nickOf(m).toLowerCase() === sn.toLowerCase();
}
function nickStyle(m: BufferMember): { color: string } | null {
  // Away members render in a flat muted color — the .away CSS rule wins
  // regardless of inline style, but skipping the inline color keeps the DOM
  // honest.
  if (isAway(m)) return null;
  if (isSelf(m)) return { color: nicks.selfColor.value };
  const c = nicks.color(nickOf(m));
  return c ? { color: c } : null;
}

function nickOf(m: BufferMember): string {
  return m.nick;
}
function userOf(m: BufferMember): string | null {
  return m.user ?? null;
}
function hostOf(m: BufferMember): string | null {
  return m.host ?? null;
}
function modesOf(m: BufferMember): string[] {
  return Array.isArray(m?.modes) ? m.modes : [];
}

// Click handlers funnel through one builder so right-click, row-click
// (mobile tap, desktop click — member rows have no other action), and the
// hover three-dots all open the same menu. Anchor by event coords for the
// row paths and by button rect for the three-dots so the popup drops out
// from the affordance the user actually pointed at.
function menuContext() {
  return {
    networkId: buffer.value?.networkId ?? 0,
    isSelf,
    onIgnore: (m: BufferMember) => {
      modalMember.value = m;
    },
    channel: buffer.value?.target ?? null,
    selfModes: selfModes.value,
  };
}
function onRowClick(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  // Left-click: pass the row as the trigger so re-clicking it toggles closed.
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY, e.currentTarget as Element);
}
function onRowContextMenu(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  // Right-click: no trigger — a second right-click repositions, as is conventional.
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY);
}
function onActionsClick(e: MouseEvent, m: BufferMember): void {
  if (!buffer.value) return;
  memberActions.openMenuFromButton(m, menuContext(), e.currentTarget as Element);
}
function prefixOf(m: BufferMember): string {
  return modePrefixOf(modesOf(m));
}
function prefixClass(m: BufferMember): string {
  return modePrefixClass(modesOf(m));
}
function isAway(m: BufferMember): boolean {
  return !!m?.away;
}
function liClass(m: BufferMember): string[] {
  const classes: string[] = [];
  const p = prefixClass(m);
  if (p) classes.push(p);
  if (isAway(m)) classes.push('away');
  return classes;
}

const sorted = computed(() => {
  const networkId = buffer.value?.networkId;
  const channel = buffer.value?.target ?? '';
  const list = members.value;
  // Self is always visible — guards against the corner case of a mask
  // matching the user's own nick (or a hostmask the server-side nick
  // happens to fall into) which would otherwise vanish them from their
  // own nicklist. Only whole-identity ALL rules drop a member here — a
  // content/level/NOHIGHLIGHT rule leaves them in the nicklist (#301).
  const filtered = networkId
    ? list.filter((m) => {
        if (isSelf(m)) return true;
        const nick = nickOf(m);
        const userhost = m.user && m.host ? `${nick}!${m.user}@${m.host}` : null;
        return !ignores.isMemberHidden(networkId, nick, userhost, channel);
      })
    : list;
  return filtered.toSorted((a, b) => {
    const pa = PREFIX_ORDER.indexOf(prefixOf(a));
    const pb = PREFIX_ORDER.indexOf(prefixOf(b));
    if (pa !== pb) return pa - pb;
    return nickOf(a).localeCompare(nickOf(b), undefined, { sensitivity: 'base' });
  });
});
</script>

<style scoped>
.members {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.members-head {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
/* Layout only — color/border/disabled come from the global button language. */
.call-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}
.call-policy {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  color: var(--fg-muted);
}
.call-policy select {
  flex: 1;
  min-width: 0;
}
.guest-links {
  margin-top: var(--space-3);
}
.guest-mint {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.guest-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
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
  margin-top: var(--space-3);
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
  margin: var(--space-2) 0 0;
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
ul {
  list-style: none;
  margin: 0;
  padding: var(--space-2) 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
li {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: 1px var(--space-5);
  min-width: 0;
  user-select: none;
  cursor: pointer;
  position: relative;
}
li:hover {
  background: var(--bg-soft);
}

/* Hover affordance — floats over the right edge of the row instead of taking
   a flex slot, so long nicks aren't pushed into a narrower column when the
   button is hidden. A short gradient fade behind the icon (matched to the
   row's hover background) keeps the glyph readable on top of any nick that
   gets truncated under it. Hidden entirely on touch breakpoints; mobile uses
   tap-anywhere-on-row to open the same menu. */
.row-actions {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  padding: 0 var(--space-4) 0 var(--space-7);
  background: linear-gradient(to right, transparent 0, var(--bg-soft) 12px);
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  transition: opacity 80ms linear;
}
li:hover .row-actions,
.row-actions:focus-visible {
  opacity: 1;
}
.row-actions:hover {
  color: var(--fg);
}
@media (max-width: 768px) {
  .row-actions {
    display: none;
  }
}
.prefix {
  width: 10px;
  flex: 0 0 auto;
  text-align: center;
  color: var(--fg-muted);
}
li.mode-\~ .prefix {
  color: var(--member-owner);
}
li.mode-\& .prefix {
  color: var(--member-admin);
}
li.mode-\@ .prefix {
  color: var(--member-op);
}
li.mode-\% .prefix {
  color: var(--member-halfop);
}
li.mode-\+ .prefix {
  color: var(--member-voice);
}
.nick {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
/* Away nicks lose all per-user color and render in a flat muted gray. The
   rule overrides the inline nickStyle (which is suppressed for away anyway)
   and the prefix mode colors so the whole row reads as inert. */
li.away .nick,
li.away .prefix {
  color: var(--fg-muted) !important;
}
</style>
