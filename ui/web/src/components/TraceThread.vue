<script setup lang="ts">
import type { Detail } from '../../../server/types';
import { formatDay, roleLabel } from '../format';

defineProps<{ detail: Detail }>();
defineEmits<{ open: [id: string] }>();

const said = (role: string): string => {
  const w = roleLabel(role);
  return w === 'You' ? 'You said' : w === 'Claude' ? 'Claude said' : w;
};
</script>

<template>
  <div v-if="detail.kind === 'memory'" class="trace">
    <h2>Where this came from</h2>
    <p>Every memory cites the messages it was built from. Nothing is kept without a source.</p>
    <ol class="thread">
      <li class="head">
        <div class="who"><b>This memory</b><span>written {{ formatDay(detail.memory.recordedAt) }}</span></div>
      </li>
      <li v-for="s in detail.sources" :key="s.message.id">
        <div class="who">
          <b>{{ said(s.message.role) }}</b><span>{{ formatDay(s.message.ts) }}</span><span>session {{ s.message.sessionId }}</span>
        </div>
        <div class="said">{{ s.excerpt ?? s.message.text + (s.message.cut ? '…' : '') }}</div>
        <button type="button" class="link" @click="$emit('open', s.message.id)">Open message</button>
      </li>
      <li v-for="m in detail.replaces" :key="m.id">
        <div class="who"><b>Replaced an earlier memory</b><span>{{ formatDay(m.since) }}</span></div>
        <div class="said">{{ m.statement }}</div>
        <button type="button" class="link" @click="$emit('open', m.id)">Open memory</button>
      </li>
      <li v-if="detail.replacedBy">
        <div class="who"><b>Replaced by a newer memory</b><span>{{ formatDay(detail.replacedBy.since) }}</span></div>
        <div class="said">{{ detail.replacedBy.statement }}</div>
        <button type="button" class="link" @click="$emit('open', detail.replacedBy.id)">Open memory</button>
      </li>
    </ol>
  </div>
  <div v-else class="trace">
    <h2>Memories built from this</h2>
    <ol v-if="detail.built.length" class="thread">
      <li v-for="m in detail.built" :key="m.id" class="head">
        <div class="said">{{ m.statement }}</div>
        <button type="button" class="link" @click="$emit('open', m.id)">Open memory</button>
      </li>
    </ol>
    <p v-else>None yet.</p>
  </div>
</template>
