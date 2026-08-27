<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Storage stats (lurker-dev/RETENTION_PLAN.md §3.4): how much history each
  account holds, what the database file costs on disk, and which retention
  ceilings the deployment declares. Visibility only — the plan deliberately
  ships no per-account quotas, so this pane is how an operator notices
  buffer-farming before designing any automated defense.
-->

<template>
  <section id="admin-storage" class="settings-pane">
    <h2>storage</h2>
    <p class="section-desc">
      What message history costs on this instance. Sizes marked ≈ are estimated at
      {{ stats?.approxBytesPerRow ?? 281 }} bytes per stored line (row + indexes + search index).
    </p>

    <p v-if="error" class="error inline">{{ error }}</p>
    <p v-else-if="!stats" class="muted small">Loading storage stats…</p>

    <template v-if="stats">
      <ul class="counts">
        <li>database file: {{ formatBytes(stats.database.fileBytes) }}</li>
        <li v-if="stats.database.walBytes">
          write-ahead log: {{ formatBytes(stats.database.walBytes) }}
        </li>
        <li>
          reclaimable free pages: {{ formatBytes(stats.database.reclaimableBytes) }}
          <span class="muted small">(reused by new writes before the file grows)</span>
        </li>
      </ul>

      <p class="muted small">
        Retention ceilings:
        {{
          stats.ceilings.maxLines != null
            ? `${stats.ceilings.maxLines.toLocaleString()} lines per buffer`
            : 'no line ceiling (LURKER_MAX_RETENTION_LINES unset)'
        }}
        ·
        {{
          stats.ceilings.maxEventHours != null
            ? `event noise capped at ${stats.ceilings.maxEventHours}h`
            : 'no event-noise ceiling (LURKER_MAX_EVENT_RETENTION_HOURS unset)'
        }}
      </p>

      <h3 class="subhead">per account</h3>
      <ul class="device-list">
        <li v-for="u in stats.users" :key="u.id" class="device storage-row">
          <span class="who">{{ u.username }}</span>
          <span class="muted small">
            {{ u.messageRows.toLocaleString() }} lines · {{ u.buffers }} buffer(s) · ≈
            {{ formatBytes(u.messageRows * stats.approxBytesPerRow) }}
          </span>
        </li>
      </ul>
      <p class="muted small">
        Refreshed {{ stats.generatedAt }} — cached for a minute server-side.
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../../api.js';

interface StorageStats {
  generatedAt: string;
  approxBytesPerRow: number;
  database: { fileBytes: number; walBytes: number; reclaimableBytes: number };
  ceilings: { maxLines: number | null; maxEventHours: number | null };
  users: Array<{ id: number; username: string; messageRows: number; buffers: number }>;
}

const stats = ref<StorageStats | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    stats.value = await api('/api/admin/storage');
  } catch (e: any) {
    error.value = e.message || 'failed to load storage stats';
  }
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
</script>

<style src="../settings-panes/panes.css"></style>
<style scoped>
.counts {
  list-style: disc;
  padding-left: var(--space-9);
  margin: var(--space-2) 0 var(--space-5);
  color: var(--fg-muted);
}
.storage-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
}
.storage-row .who {
  color: var(--fg);
}
</style>
