<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Health } from '../../../server/types';
import { api } from '../api';
import { copyText } from '../clipboard';
import StateBlock from '../components/StateBlock.vue';
import { formatBytes, formatDayTime, formatNumber, plural, useToasts } from '../format';
import { useLatest } from '../latest';
import { classify, failureMessage, type Problem } from '../load';

const { show } = useToasts();
const data = ref<Health | null>(null);
const problem = ref<{ kind: Problem; message: string } | null>(null);
const loading = ref(true);
const exporting = ref(false);
const exportedTo = ref<string | null>(null);
const newest = useLatest();

async function load(silent = false): Promise<void> {
  const current = newest();
  if (!silent) loading.value = true;
  try {
    const h = await api.health();
    if (!current()) return;
    data.value = h;
    problem.value = null;
  } catch (e) {
    if (!current()) return;
    // A silent refresh keeps what is on screen unless the connection itself is gone.
    if (!silent || classify(e) === 'disconnected') {
      problem.value = { kind: classify(e), message: failureMessage(e) };
      if (!silent) data.value = null;
    }
  } finally {
    if (current()) loading.value = false;
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void load(true);
}
onMounted(() => {
  void load();
  document.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible));

async function exportAll(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const r = await api.exportAll();
    exportedTo.value = r.path;
    show('Exported');
  } catch (e) {
    if (classify(e) === 'disconnected') problem.value = { kind: 'disconnected', message: '' };
    else show(failureMessage(e));
  } finally {
    exporting.value = false;
  }
}

/** Long values go on their own line under the label (see .checks li.long). */
const isLong = (s: string | null | undefined): boolean => (s?.length ?? 0) > 32;
const meaning = computed(() => (data.value?.search.semantic ? 'Keywords and meaning' : 'Keywords only'));
</script>

<template>
  <StateBlock v-if="problem?.kind === 'disconnected'" kind="disconnected" />
  <template v-else>
    <header class="view-head">
      <div>
        <h1>Health</h1>
        <p>Everything engram needs to capture and recall memories on this machine.</p>
      </div>
      <button type="button" class="btn" :disabled="exporting" @click="exportAll">Export everything</button>
    </header>
    <section v-if="exportedTo" class="panel exported" aria-label="Export">
      <span>Exported to</span>
      <code>{{ exportedTo }}</code>
      <button type="button" class="btn" @click="copyText(exportedTo)">Copy</button>
    </section>

    <StateBlock v-if="problem" :kind="problem.kind === 'busy' ? 'busy' : 'error'" :message="problem.message" @retry="load()" />
    <StateBlock v-else-if="loading && !data" kind="loading" :lines="6" />
    <div v-else-if="data" class="health">
      <section class="panel" aria-label="Capture">
        <h2>Capture</h2>
        <ul class="checks">
          <li v-for="h in data.hooks" :key="h.event" :class="{ long: !h.ok && isLong(h.problem) }">
            <span>{{ h.label }}</span>
            <span v-if="h.ok" class="good">Working</span>
            <span v-else class="bad">Needs attention: {{ h.problem }}</span>
          </li>
          <li><span>Messages waiting to be saved</span><span>{{ formatNumber(data.waiting) }}</span></li>
        </ul>
      </section>

      <section class="panel" aria-label="Recall">
        <h2>Recall</h2>
        <ul class="checks">
          <li :class="{ long: data.memoryTools.checked && !data.memoryTools.ok && isLong(data.memoryTools.detail) }">
            <span>Memory tools in Claude Code</span>
            <span v-if="!data.memoryTools.checked">Not checked</span>
            <span v-else-if="data.memoryTools.ok" class="good">Working</span>
            <span v-else class="bad">Needs attention: {{ data.memoryTools.detail }}</span>
          </li>
          <li v-if="!data.memoryTools.checked && data.memoryTools.detail" class="note"><span>{{ data.memoryTools.detail }}</span></li>
          <li><span>Search</span><span>{{ meaning }}</span></li>
          <li v-if="data.search.semantic"><span>Search by meaning</span><span>{{ formatNumber(data.search.embedded) }} {{ plural(data.search.embedded, 'item', 'items') }} indexed</span></li>
          <li v-else class="note"><span>Search by meaning is off. It finds memories worded differently from your question. To turn it on, see “Semantic search” in the README.</span></li>
          <li><span>Errors in the last 24 hours</span><span>{{ data.hookErrors.last24h === 0 ? 'None' : formatNumber(data.hookErrors.last24h) }}</span></li>
        </ul>
      </section>

      <section class="panel" aria-label="Storage">
        <h2>Storage</h2>
        <ul class="checks">
          <li :class="{ long: isLong(data.storage.path) }"><span>Database</span><span>{{ data.storage.path }}</span></li>
          <li><span>Size</span><span>{{ formatBytes(data.storage.bytes) }}</span></li>
          <li>
            <span>Readable by</span>
            <span v-if="data.storage.ownerOnly">Only you</span>
            <span v-else class="bad">Others on this computer can read it</span>
          </li>
          <li><span>Last backup</span><span>{{ data.storage.newestBackup ? formatDayTime(data.storage.newestBackup) : 'None found' }}</span></li>
          <li><span>Version</span><span>engram {{ data.version }}, schema {{ data.storage.schema }}</span></li>
        </ul>
      </section>
    </div>
  </template>
</template>
