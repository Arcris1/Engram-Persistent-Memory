<script setup lang="ts">
withDefaults(defineProps<{ kind: 'loading' | 'error' | 'busy' | 'empty' | 'disconnected'; message?: string; lines?: number }>(), { message: undefined, lines: 4 });
defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="kind === 'loading'" class="skeleton" role="status" aria-busy="true">
    <span class="sr-only">Loading</span>
    <i v-for="n in lines" :key="n" aria-hidden="true"></i>
  </div>
  <div v-else-if="kind === 'disconnected'" class="disconnected" role="alert">
    <section class="panel">
      <h1>This page is no longer connected.</h1>
      <p>Run <code>engram ui</code> again.</p>
    </section>
  </div>
  <section v-else-if="kind === 'error' || kind === 'busy'" class="panel problem" role="alert">
    <p>{{ message ?? (kind === 'busy' ? 'engram is busy writing. Try again.' : 'Something went wrong. Try again.') }}</p>
    <button type="button" class="btn" @click="$emit('retry')">Retry</button>
  </section>
  <p v-else class="empty"><slot /></p>
</template>
