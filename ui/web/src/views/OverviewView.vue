<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Overview } from '../../../server/types';
import { api } from '../api';
import ActivityChart from '../components/ActivityChart.vue';
import ConsolidateHint from '../components/ConsolidateHint.vue';
import ProfileList from '../components/ProfileList.vue';
import StateBlock from '../components/StateBlock.vue';
import { formatNumber, plural, useToasts } from '../format';
import { useLatest } from '../latest';
import { classify, failureMessage, type Problem } from '../load';
import { useRoute } from '../router';
import { shared } from '../store';

const { show } = useToasts();
const { go } = useRoute();

const data = ref<Overview | null>(null);
const problem = ref<{ kind: Problem; message: string } | null>(null);
const loading = ref(true);
const projects = ref<string[]>([]);
const project = ref('');
const pausing = ref(false);
const newest = useLatest();
watch(project, () => void load());

/** The one place the paused flag is written (screen data and the shared copy the rail and Memories read). */
function applyPaused(paused: boolean): void {
  if (data.value) data.value = { ...data.value, paused };
  shared.paused = paused;
}

async function load(silent = false): Promise<void> {
  const current = newest();
  if (!silent) loading.value = true;
  try {
    const o = await api.overview(project.value || null);
    if (!current()) return; // a newer request has been made since
    data.value = o;
    applyPaused(o.paused);
    problem.value = null;
    shared.memories = o.stats.claims.active;
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

async function loadProjects(): Promise<void> {
  try {
    projects.value = await api.projects();
  } catch {
    /* the selector then offers only "Any session" */
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible') {
    void load(true);
    void loadProjects();
  }
}

onMounted(() => {
  void load();
  void loadProjects();
  document.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible));

async function togglePause(): Promise<void> {
  if (!data.value || pausing.value) return;
  pausing.value = true;
  try {
    const next = data.value.paused ? await api.resume() : await api.pause();
    applyPaused(next.paused);
    show(next.paused ? 'Capture paused' : 'Capture resumed');
    void load(true); // supersedes any older response still in flight, so it cannot overwrite this result
  } catch (e) {
    if (classify(e) === 'disconnected') problem.value = { kind: 'disconnected', message: '' };
    else show(failureMessage(e));
  } finally {
    pausing.value = false;
  }
}

const total14 = computed(() => (data.value?.activity ?? []).reduce((n, a) => n + a.count, 0));
</script>

<template>
  <StateBlock v-if="problem?.kind === 'disconnected'" kind="disconnected" />
  <template v-else>
    <header class="view-head">
      <div>
        <h1>What Claude is told when a session starts</h1>
        <p>These memories are handed to Claude at the start of every session, marked as stored data rather than instructions.</p>
      </div>
      <div class="pick">
        <label class="sr-only" for="ov-project">Which sessions</label>
        <select id="ov-project" v-model="project">
          <option value="">Any session</option>
          <option v-for="p in projects" :key="p" :value="p">Sessions in {{ p }}</option>
        </select>
        <button type="button" class="btn" @click="go({ view: 'memories', id: null })">Browse all memories</button>
      </div>
    </header>

    <StateBlock v-if="problem" :kind="problem.kind === 'busy' ? 'busy' : 'error'" :message="problem.message" @retry="load()" />
    <StateBlock v-else-if="loading && !data" kind="loading" :lines="6" />
    <div v-else-if="data" class="overview">
      <section class="panel profile" aria-label="Session profile">
        <template v-if="data.profile.length">
          <ProfileList :profile="data.profile" />
        </template>
        <template v-else>
          <p class="none">Claude isn't told anything yet. Memories appear here after consolidation.</p>
          <template v-if="data.stats.unconsolidated_sessions === 0">
            <p>Captured messages only become memories Claude can use after consolidation. Run this inside Claude Code:</p>
            <ConsolidateHint />
          </template>
          <p v-else>Captured messages only become memories Claude can use after consolidation.</p>
        </template>
      </section>

      <div class="side">
        <section class="panel">
          <div class="state" :class="{ paused: data.paused }">
            <h2><span class="dot"></span>{{ data.paused ? 'Capture is paused' : 'Capturing new messages' }}</h2>
            <button type="button" class="btn" :disabled="pausing" @click="togglePause">{{ data.paused ? 'Resume capture' : 'Pause capture' }}</button>
          </div>
        </section>

        <section v-if="data.stats.unconsolidated_sessions > 0" class="panel notice">
          <h2>{{ formatNumber(data.stats.unconsolidated_sessions) }} {{ plural(data.stats.unconsolidated_sessions, 'session is', 'sessions are') }} waiting to be turned into memories</h2>
          <p>Captured messages only become memories Claude can use after consolidation. Run this inside Claude Code:</p>
          <ConsolidateHint />
        </section>

        <section class="panel">
          <h2>Captured in the last {{ data.activity.length }} days</h2>
          <p>
            <b>{{ formatNumber(total14) }}</b> {{ plural(total14, 'message', 'messages') }} in this period. In all, <b>{{ formatNumber(data.stats.events) }}</b>
            {{ plural(data.stats.events, 'message', 'messages') }} from <b>{{ formatNumber(data.stats.sessions) }}</b> {{ plural(data.stats.sessions, 'session', 'sessions') }}, kept as
            <b>{{ formatNumber(data.stats.claims.active) }}</b> current {{ plural(data.stats.claims.active, 'memory', 'memories') }}.
          </p>
          <ActivityChart :activity="data.activity" />
        </section>
      </div>
    </div>
  </template>
</template>
