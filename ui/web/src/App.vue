<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import AppRail from './components/AppRail.vue';
import StateBlock from './components/StateBlock.vue';
import ToastHost from './components/ToastHost.vue';
import { useRoute } from './router';
import { shared } from './store';
import HealthView from './views/HealthView.vue';
import MemoriesView from './views/MemoriesView.vue';
import OverviewView from './views/OverviewView.vue';

defineProps<{ connected: boolean }>();
const { route, go } = useRoute();
const view = computed(() => (route.value.view === 'memories' ? MemoriesView : route.value.view === 'health' ? HealthView : OverviewView));

const TITLES = { overview: 'Overview', memories: 'Memories', health: 'Health' } as const;
watchEffect(() => {
  document.title = `${TITLES[route.value.view]} – engram`;
});
</script>

<template>
  <StateBlock v-if="!connected" kind="disconnected" />
  <template v-else>
    <div class="app">
      <AppRail :view="route.view" :memories="shared.memories" @go="(v) => go(v === 'memories' ? { view: 'memories', id: null } : { view: v })" />
      <main id="main"><component :is="view" /></main>
    </div>
  </template>
  <ToastHost />
</template>
