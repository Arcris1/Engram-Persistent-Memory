<script setup lang="ts">
import type { MemoryLine } from '../../../server/types';
import { formatDay, plural } from '../format';

defineProps<{ profile: MemoryLine[] }>();
</script>

<template>
  <ol>
    <li v-for="m in profile" :key="m.id">
      <q>{{ m.statement }}</q>
      <span v-if="m.pinned" class="chip pin">Pinned</span>
      <span v-else-if="m.used >= 1" class="chip plain">Used {{ m.used }}×</span>
      <span>{{ m.project ?? 'All projects' }}, since {{ formatDay(m.since) }}, from {{ m.sources }} {{ plural(m.sources, 'message', 'messages') }}</span>
    </li>
  </ol>
</template>
