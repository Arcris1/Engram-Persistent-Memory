<script setup lang="ts">
import { useTheme, type ThemeMode } from '../theme';

const { mode, set } = useTheme();
const options: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
</script>

<template>
  <div class="rail-theme">
    <span id="theme-label">Theme</span>
    <div class="seg" role="group" aria-labelledby="theme-label">
      <button v-for="o in options" :key="o.value" type="button" :aria-pressed="mode === o.value" @click="set(o.value)">{{ o.label }}</button>
    </div>
  </div>
</template>
