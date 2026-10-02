<script setup lang="ts">
import type { MemoryLine, MessageLine } from '../../../server/types';
import { formatDay, roleLabel } from '../format';
import type { Kind, Row } from '../useMemories';

const props = defineProps<{ items: Row[]; kind: Kind; selected: string | null; hasMore: boolean; loadingMore: boolean; moreError?: string | null }>();
defineEmits<{ select: [id: string]; more: [] }>();

const stop = (props: { items: Row[]; selected: string | null }, id: string): 0 | -1 => {
  const first = props.items[0]?.id;
  const at = props.selected && props.items.some((r) => r.id === props.selected) ? props.selected : first;
  return id === at ? 0 : -1;
};
const asMemory = (r: Row): MemoryLine => r as MemoryLine;
const asMessage = (r: Row): MessageLine => r as MessageLine;
const who = (r: Row): string => {
  const w = roleLabel(asMessage(r).role);
  return w === 'A tool result' ? 'Tool' : w;
};
</script>

<template>
  <div class="panel list">
    <div role="listbox" :aria-label="kind === 'memories' ? 'Memories' : 'Captured messages'">
      <button
        v-for="r in items"
        :key="r.id"
        type="button"
        class="row"
        :class="{ event: kind === 'messages', old: kind === 'memories' && asMemory(r).status !== 'active' }"
        role="option"
        :data-id="r.id"
        :aria-selected="r.id === selected"
        :tabindex="stop(props, r.id)"
        @click="$emit('select', r.id)"
      >
        <span class="text">{{ kind === 'memories' ? asMemory(r).statement : asMessage(r).text + (asMessage(r).cut ? '…' : '') }}</span>
        <span class="meta">
          <span v-if="kind === 'memories' && asMemory(r).pinned" class="chip pin">Pinned</span>
          <span v-if="kind === 'memories' && asMemory(r).status !== 'active'" class="chip plain">Replaced</span>
          <span v-if="r.flags.length" class="chip warn">Flagged</span>
          <span>{{ r.project ?? (kind === 'messages' ? 'No project' : 'All projects') }}</span>
          <span>{{ formatDay(kind === 'memories' ? asMemory(r).since : asMessage(r).ts) }}</span>
          <span v-if="kind === 'messages'">{{ who(r) }}</span>
        </span>
      </button>
    </div>
    <div v-if="hasMore || moreError" class="more">
      <p v-if="moreError" class="warning" role="alert">{{ moreError }}</p>
      <button type="button" class="btn" :disabled="loadingMore" @click="$emit('more')">{{ loadingMore ? 'Loading…' : moreError ? 'Retry' : 'Load more' }}</button>
    </div>
  </div>
</template>
