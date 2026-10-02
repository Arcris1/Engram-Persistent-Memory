<script setup lang="ts">
import { formatNumber } from '../format';
import type { Route } from '../router';
import ThemeToggle from './ThemeToggle.vue';

defineProps<{ view: Route['view']; memories: number | null }>();
const emit = defineEmits<{ go: [view: Route['view']] }>();

function go(view: Route['view']): void {
  emit('go', view);
}
</script>

<template>
  <aside class="rail">
    <div class="brand"><i aria-hidden="true"></i>engram</div>
    <nav class="nav" aria-label="Sections">
      <button type="button" :aria-current="view === 'overview' ? 'page' : undefined" @click="go('overview')">Overview</button>
      <button type="button" :aria-current="view === 'memories' ? 'page' : undefined" @click="go('memories')">
        Memories <span v-if="memories !== null" class="n">{{ formatNumber(memories) }}</span>
      </button>
      <button type="button" :aria-current="view === 'health' ? 'page' : undefined" @click="go('health')">Health</button>
    </nav>
    <ThemeToggle />
    <p class="rail-note">Local only. Nothing leaves this machine.</p>
  </aside>
</template>
