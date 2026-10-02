<script setup lang="ts">
import { useToasts } from '../format';

const { show } = useToasts();

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText('/consolidate');
    show('Copied');
  } catch {
    show('/consolidate');
  }
}
</script>

<template>
  <div class="cmd">
    <code>/consolidate</code>
    <button type="button" class="btn" @click="copy">Copy</button>
  </div>
</template>
