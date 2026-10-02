<script setup lang="ts">
import type { Detail } from '../../../server/types';
import { copyText } from '../clipboard';
import { aboutLabel, formatDay, usedLabel } from '../format';
import TraceThread from './TraceThread.vue';

const props = defineProps<{ detail: Extract<Detail, { kind: 'memory' }>; paused: boolean; pinning: boolean }>();
defineEmits<{ pin: []; forget: [opener: HTMLElement]; open: [id: string] }>();
const m = (): typeof props.detail.memory => props.detail.memory;
</script>

<template>
  <section class="panel detail" aria-label="Memory detail">
    <div class="kind">
      <span class="chip">Memory</span>
      <span v-if="m().pinned" class="chip pin">Pinned</span>
      <span v-if="m().status !== 'active'" class="chip plain">Replaced</span>
    </div>
    <blockquote>{{ m().statement }}</blockquote>
    <dl class="facts">
      <dt>About</dt><dd>{{ aboutLabel(m().subject, m().predicate) }}</dd>
      <dt>Project</dt><dd>{{ m().project ?? 'All projects' }}</dd>
      <dt>True since</dt><dd>{{ formatDay(m().since) }}<template v-if="m().until"> until {{ formatDay(m().until!) }}</template></dd>
      <dt>Used by Claude</dt><dd>{{ usedLabel(m().used) }}</dd>
      <dt>Reference</dt><dd class="id">{{ m().id }}</dd>
    </dl>
    <div class="actions">
      <button type="button" class="btn" :class="{ pinned: m().pinned }" :disabled="paused || pinning" @click="$emit('pin')">{{ m().pinned ? 'Unpin' : 'Pin to every session' }}</button>
      <button type="button" class="btn" @click="copyText(m().id)">Copy reference</button>
      <button type="button" class="btn danger" :disabled="paused" @click="$emit('forget', $event.currentTarget as HTMLElement)">Forget</button>
    </div>
    <TraceThread :detail="detail" @open="(id) => $emit('open', id)" />
  </section>
</template>
