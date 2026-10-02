<script setup lang="ts">
import { useToasts } from '../format';

const { items } = useToasts();
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="t in items" :key="t.id" class="toast">{{ t.message }}</div>
  </div>
</template>
