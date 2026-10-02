<script setup lang="ts">
import type { Detail } from '../../../server/types';
import { copyText } from '../clipboard';
import { flagLabel, formatDayTime, roleLabel } from '../format';
import TraceThread from './TraceThread.vue';

const props = defineProps<{ detail: Extract<Detail, { kind: 'message' }>; paused: boolean }>();
defineEmits<{ forget: [opener: HTMLElement]; open: [id: string] }>();
const msg = (): typeof props.detail.message => props.detail.message;
const flags = (): { flag: string; label: string }[] => msg().flags.flatMap((f) => (flagLabel(f) ? [{ flag: f, label: flagLabel(f)! }] : []));
</script>

<template>
  <section class="panel detail event" aria-label="Message detail">
    <div class="kind">
      <span class="chip plain">Captured message</span>
      <span v-for="f in flags()" :key="f.flag" class="chip warn">{{ f.label }}</span>
    </div>
    <blockquote class="body">{{ msg().text }}</blockquote>
    <dl class="facts">
      <dt>From</dt><dd>{{ roleLabel(msg().role) }}</dd>
      <dt>When</dt><dd>{{ formatDayTime(msg().ts) }}</dd>
      <dt>Session</dt><dd>{{ msg().sessionId }}</dd>
      <dt>Project</dt><dd>{{ msg().project ?? 'No project' }}</dd>
      <dt>Reference</dt><dd class="id">{{ msg().id }}</dd>
    </dl>
    <p v-if="msg().flags.includes('instruction_like')" class="note">This text reads like a command, so it is never shown to Claude automatically and cannot become a memory on its own.</p>
    <div class="actions">
      <button type="button" class="btn" @click="copyText(msg().id)">Copy reference</button>
      <button type="button" class="btn danger" :disabled="paused" @click="$emit('forget', $event.currentTarget as HTMLElement)">Forget</button>
    </div>
    <TraceThread :detail="detail" @open="(id) => $emit('open', id)" />
  </section>
</template>
