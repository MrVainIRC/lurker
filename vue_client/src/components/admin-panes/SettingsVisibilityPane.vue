<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section class="settings-pane">
    <h2>User settings</h2>
    <p class="section-desc">
      Choose which settings regular users can see in their Settings screen. Administrators always
      see every setting. Hidden settings remain stored and can be shown again later.
    </p>
    <p v-if="store.error" class="error inline">{{ store.error }}</p>
    <p v-if="!users.length && store.settingsVisibilityLoaded" class="muted small">
      No regular users.
    </p>
    <div v-for="user in users" :key="user.id" class="user-card">
      <header class="user-head">
        <h3>{{ user.username }}</h3>
        <button type="button" class="link" :disabled="busy" @click="showAll(user)">Show all</button>
        <button type="button" class="link" :disabled="busy" @click="hideAll(user)">Hide all</button>
      </header>
      <div v-for="group in groups" :key="group.id" class="setting-group">
        <h4>{{ group.label }}</h4>
        <label v-for="option in group.options" :key="option.key" class="setting-option">
          <input
            type="checkbox"
            :checked="!user.hiddenKeys.includes(option.key)"
            :disabled="busy"
            @change="toggle(user, option.key)"
          />
          <span>{{ option.label }}</span>
          <code>{{ option.key }}</code>
        </label>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAdminStore, type AdminSettingVisibility } from '../../stores/admin.js';
import { REGISTRY, CATEGORIES } from '../../../../shared/settingsRegistry.js';

const store = useAdminStore();
const busy = ref(false);
const users = computed(() => store.settingsVisibility);
const groups = computed(() =>
  CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    options: REGISTRY.filter((option) => option.category === category.id),
  })).filter((group) => group.options.length),
);

onMounted(() => {
  store.fetchSettingsVisibility().catch(() => {});
});

async function save(user: AdminSettingVisibility, hiddenKeys: string[]): Promise<void> {
  busy.value = true;
  try {
    await store.setSettingsVisibility(user.id, hiddenKeys);
  } catch {
    // The store retains the server error and the previous row state.
  } finally {
    busy.value = false;
  }
}

function toggle(user: AdminSettingVisibility, key: string): void {
  const hidden = new Set(user.hiddenKeys);
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  void save(user, [...hidden]);
}

function showAll(user: AdminSettingVisibility): void {
  void save(user, []);
}

function hideAll(user: AdminSettingVisibility): void {
  void save(user, [...store.settingKeys]);
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.user-card {
  padding: var(--space-5) 0;
  border-top: 1px solid var(--border);
}
.user-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.user-head h3 {
  flex: 1;
  margin: 0;
}
.setting-group {
  margin-top: var(--space-5);
}
.setting-group h4 {
  margin: 0 0 var(--space-2);
  color: var(--fg-muted);
  font-weight: 600;
}
.setting-option {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  cursor: pointer;
}
.setting-option code {
  color: var(--fg-muted);
}
</style>
