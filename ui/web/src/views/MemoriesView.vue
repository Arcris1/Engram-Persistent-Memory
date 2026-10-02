<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ForgetDone } from '../../../server/types';
import { api } from '../api';
import ForgetDialog from '../components/ForgetDialog.vue';
import MemoryDetail from '../components/MemoryDetail.vue';
import MemoryList from '../components/MemoryList.vue';
import MemoryToolbar from '../components/MemoryToolbar.vue';
import MessageDetail from '../components/MessageDetail.vue';
import StateBlock from '../components/StateBlock.vue';
import { inScrollable, scrollBehavior } from '../motion';
import { useRoute } from '../router';
import { loadShared, shared } from '../store';
import { useDetail } from '../useDetail';
import { useMemories } from '../useMemories';

const { route, go } = useRoute();
const list = useMemories();
const d = useDetail({
  onGone: () => void list.load(true),
  onPinned: (id, pinned) => list.patch(id, { pinned }),
  kindHint: (id) => {
    const row = list.items.value.find((r) => r.id === id);
    return row ? ('text' in row ? 'message' : 'memory') : null;
  },
});
const selected = computed(() => (route.value.view === 'memories' ? route.value.id : null));
const projects = ref<string[]>([]);
const forget = ref<{ opener: HTMLElement | null; id: string; kind: 'memory' | 'message' } | null>(null);
const lost = ref(false);
const detailCol = ref<HTMLElement | null>(null);
const listCol = ref<HTMLElement | null>(null);

const disconnected = computed(() => lost.value || list.problem.value?.kind === 'disconnected' || d.problem.value?.kind === 'disconnected');
const unfilteredEmpty = computed(() => !list.loading.value && !list.problem.value && !list.items.value.length && !list.filtered.value);
const noun = computed(() => (list.kind.value === 'memories' ? 'memory' : 'message'));

watch(selected, (id) => void d.open(id), { immediate: true });
// A link (or a deep link) to the other kind of item switches the list to that kind, unfiltered.
watch(d.detail, (v) => {
  const k = v?.kind === 'message' ? 'messages' : v?.kind === 'memory' ? 'memories' : null;
  if (k && k !== list.kind.value) list.reset(k);
});

function setKind(k: 'memories' | 'messages'): void {
  list.setKind(k);
  go({ view: 'memories', id: null });
}

/** Narrow screens stack the detail under the list; desktop shows them side by side. Without matchMedia, neither is assumed. */
const narrow = (): boolean => Boolean(window.matchMedia?.('(max-width: 900px)').matches);
const desktop = (): boolean => {
  const mq = window.matchMedia?.('(max-width: 900px)');
  return mq !== undefined && !mq.matches;
};

/** Clicks add a history entry; keyboard moves and automatic selection replace it. */
function open(id: string, how: { scroll?: boolean; replace?: boolean } = {}): void {
  go({ view: 'memories', id }, how.replace);
  if (how.scroll !== false && narrow()) void nextTick(() => detailCol.value?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' }));
}

function rowEl(id: string | null): HTMLElement | undefined {
  return Array.from(listCol.value?.querySelectorAll<HTMLElement>('[role=option]') ?? []).find((el) => el.dataset.id === id);
}

// Desktop with rows but nothing selected: select the first row so the detail pane is never an empty box.
watch([() => list.items.value, selected, () => list.loading.value], () => {
  const first = list.items.value[0];
  if (first && !selected.value && !list.loading.value && !forget.value && desktop()) open(first.id, { scroll: false, replace: true });
});

function reveal(id: string | null): void {
  void nextTick(() => {
    rowEl(id)?.scrollIntoView?.({ block: 'nearest' });
  });
}
watch(selected, reveal);

/** Moves the selection; false (and nothing happens) when it cannot move, so the key can keep scrolling the page. */
function move(delta: 1 | -1): boolean {
  const ids = list.items.value.map((r) => r.id);
  if (!ids.length) return false;
  const at = selected.value ? ids.indexOf(selected.value) : -1;
  const to = at < 0 ? (delta === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta));
  if (to === at) return false;
  open(ids[to]!, { scroll: false, replace: true });
  void nextTick(() => rowEl(ids[to]!)?.focus()); // focus follows the selection so Enter and screen readers act on the row
  return true;
}

function newForget(opener: HTMLElement | null): void {
  const detail = d.detail.value;
  if (!detail || !selected.value) return;
  forget.value = { opener, id: selected.value, kind: detail.kind };
}

function onKey(e: KeyboardEvent): void {
  if (forget.value || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === '/') {
    e.preventDefault();
    document.querySelector<HTMLInputElement>('[data-search]')?.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (inScrollable(t)) return;
    if (move(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
  }
}

function refresh(): void {
  if (document.visibilityState !== 'visible') return;
  if (list.items.value.length <= 50) void list.load(true); // a longer list was paged in by hand: leave it
  void d.open(selected.value, true);
  void loadShared();
  void loadProjects();
}
async function loadProjects(): Promise<void> {
  try {
    projects.value = await api.projects();
  } catch {
    /* the project selector then offers only All and No project */
  }
}

async function forgotten(id: string, erased: string[]): Promise<void> {
  forget.value = null;
  // The toast and the rail count come from forget.ts (they survive leaving this screen); the list is this view's job.
  const ids = [...new Set([id, ...erased])];
  const rows = list.items.value.map((r) => r.id);
  const at = rows.indexOf(id);
  const neighbour = [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0)).reverse()].find((r) => !ids.includes(r)) ?? null;
  list.remove(ids); // keeps rows the person paged in by hand
  if (selected.value === id) go({ view: 'memories', id: desktop() ? neighbour : null }, true);
  if (!list.paged.value) await list.load(true);
  // The Forget button is gone: put focus back in the list (or the search box) rather than on <body>.
  await nextTick();
  const target = rowEl(selected.value) ?? listCol.value?.querySelector<HTMLElement>('[role=option]') ?? document.querySelector<HTMLElement>('[data-search]');
  target?.focus();
}

function dialogGone(): void {
  const g = forget.value;
  forget.value = null;
  if (g && selected.value === g.id) d.markGone(g.id);
  else void list.load(true);
}

onMounted(() => {
  void list.load();
  void loadShared();
  void loadProjects();
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', refresh);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('visibilitychange', refresh);
});
</script>

<template>
  <StateBlock v-if="disconnected" kind="disconnected" />
  <template v-else>
    <header class="view-head">
      <div>
        <h1>Memories</h1>
        <p>Memories are the facts Claude keeps. Captured messages are the raw record they are built from.</p>
      </div>
    </header>
    <p v-if="shared.paused" class="banner" role="status">engram is paused. Pin and forget are disabled until you resume.</p>
    <MemoryToolbar v-model:text="list.text.value" v-model:project="list.project.value" v-model:pinned="list.pinned.value" v-model:replaced="list.replaced.value" v-model:flagged="list.flagged.value" :kind="list.kind.value" :projects="projects" @kind="setKind" />
    <div class="ledger">
      <div ref="listCol" class="listcol">
        <StateBlock v-if="list.problem.value && !list.items.value.length" :kind="list.problem.value.kind === 'busy' ? 'busy' : 'error'" :message="list.problem.value.message" @retry="list.load()" />
        <div v-else-if="list.loading.value && !list.items.value.length" class="panel pad"><StateBlock kind="loading" :lines="6" /></div>
        <div v-else-if="unfilteredEmpty" class="panel">
          <template v-if="list.kind.value === 'memories'">
            <p class="empty">No memories yet. Captured messages become memories after consolidation.</p>
            <p class="empty-action"><button type="button" class="btn" @click="setKind('messages')">Show captured messages</button></p>
          </template>
          <p v-else class="empty">Nothing captured yet. Start a Claude Code session and it will appear here.</p>
        </div>
        <div v-else-if="!list.items.value.length" class="panel">
          <p v-if="list.q.value" class="empty">Nothing matches “{{ list.q.value }}”. Try fewer words, or switch to captured messages.</p>
          <p v-else class="empty">Nothing matches these filters.</p>
        </div>
        <MemoryList v-else :items="list.items.value" :kind="list.kind.value" :selected="selected" :has-more="list.next.value !== null" :loading-more="list.loadingMore.value" :more-error="list.moreError.value" @select="(id) => open(id)" @more="list.more()" />
      </div>
      <div ref="detailCol">
        <StateBlock v-if="d.problem.value" :kind="d.problem.value.kind === 'busy' ? 'busy' : 'error'" :message="d.problem.value.message" @retry="d.open(selected)" />
        <section v-else-if="d.gone.value" class="panel detail"><p class="empty">{{ d.gone.value === 'unknown' ? 'This item no longer exists.' : `This ${d.gone.value} no longer exists.` }}</p></section>
        <MemoryDetail v-else-if="d.detail.value?.kind === 'memory'" :detail="d.detail.value" :paused="shared.paused" :pinning="d.pinning.value" @pin="d.togglePin" @forget="(el) => newForget(el)" @open="(id) => open(id)" />
        <MessageDetail v-else-if="d.detail.value?.kind === 'message'" :detail="d.detail.value" :paused="shared.paused" @forget="(el) => newForget(el)" @open="(id) => open(id)" />
        <section v-else-if="d.loading.value" class="panel detail"><StateBlock kind="loading" :lines="5" /></section>
        <section v-else class="panel detail"><p class="empty">Select a {{ noun }} to see where it came from.</p></section>
      </div>
    </div>
    <ForgetDialog v-if="forget" :id="forget.id" :kind="forget.kind" :opener="forget.opener" @close="forget = null" @done="(_r: ForgetDone, id: string, erased: string[]) => void forgotten(id, erased)" @gone="dialogGone" @paused="shared.paused = true" @disconnected="lost = true" />
  </template>
</template>
