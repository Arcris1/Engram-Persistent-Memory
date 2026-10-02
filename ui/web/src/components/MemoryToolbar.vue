<script setup lang="ts">
import { NO_PROJECT, type Kind } from '../useMemories';

defineProps<{ kind: Kind; projects: string[] }>();
defineEmits<{ kind: [k: Kind] }>();
const text = defineModel<string>('text', { required: true });
const project = defineModel<string>('project', { required: true });
const pinned = defineModel<boolean>('pinned', { required: true });
const replaced = defineModel<boolean>('replaced', { required: true });
const flagged = defineModel<boolean>('flagged', { required: true });
</script>

<template>
  <div class="tools">
    <div class="searchbox">
      <input v-model="text" type="search" :placeholder="kind === 'memories' ? 'Search memories' : 'Search captured messages'" :aria-label="kind === 'memories' ? 'Search memories' : 'Search captured messages'" autocomplete="off" data-search />
      <p v-if="text.trim()" class="hint">Keyword search, showing up to 50 matches.</p>
    </div>
    <div class="seg" role="group" aria-label="Show">
      <button type="button" :aria-pressed="kind === 'memories'" @click="$emit('kind', 'memories')">Memories</button>
      <button type="button" :aria-pressed="kind === 'messages'" @click="$emit('kind', 'messages')">Captured messages</button>
    </div>
    <select v-model="project" aria-label="Project">
      <option value="">All projects</option>
      <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
      <option :value="NO_PROJECT">No project</option>
    </select>
    <template v-if="kind === 'memories'">
      <label class="toggle"><input v-model="pinned" type="checkbox" /> Pinned only</label>
      <label class="toggle"><input v-model="replaced" type="checkbox" /> Include replaced</label>
    </template>
    <label v-else class="toggle"><input v-model="flagged" type="checkbox" /> Flagged only</label>
  </div>
</template>
