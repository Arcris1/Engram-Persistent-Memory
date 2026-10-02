import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { MemoryLine, MessageLine } from '../../server/types';
import { api, type MemoriesQuery } from './api';
import { useLatest } from './latest';
import { classify, failureMessage, type Problem } from './load';

export type Kind = 'memories' | 'messages';
export type Row = MemoryLine | MessageLine;
/** Client-only select value for "No project" (never sent; a project named "-" stays distinct). */
export const NO_PROJECT = '\u0000none';
const DEBOUNCE_MS = 250;

/** The list side of the Memories screen: filters, search (debounced), paging, and stale-response protection. */
export function useMemories() {
  const kind = ref<Kind>('memories');
  const text = ref(''); // what is typed
  const q = ref(''); // what is searched (after the debounce)
  const project = ref(''); // '' = all projects, NO_PROJECT = no project
  const pinned = ref(false);
  const replaced = ref(false);
  const flagged = ref(false);

  const items = ref<Row[]>([]);
  const next = ref<number | null>(null);
  const loading = ref(true);
  const loadingMore = ref(false);
  const moreError = ref<string | null>(null); // a failed "Load more": shown under the list with Retry
  const paged = ref(false); // rows were added by hand with "Load more"
  const problem = ref<{ kind: Problem; message: string } | null>(null);
  const newest = useLatest();
  let generation = 0; // bumped by every load(); a "load more" from an older generation is dropped
  let moreRun = 0;

  const query = computed<MemoriesQuery>(() => {
    const out: MemoriesQuery = { kind: kind.value };
    if (q.value) out.q = q.value;
    if (project.value === NO_PROJECT) out.project = null;
    else if (project.value) out.project = project.value;
    if (kind.value === 'memories') {
      if (pinned.value) out.pinned = true;
      if (replaced.value) out.replaced = true;
    } else if (flagged.value) out.flagged = true;
    return out;
  });
  const filtered = computed(() => Boolean(q.value || project.value || pinned.value || replaced.value || flagged.value));

  async function load(silent = false): Promise<void> {
    const current = newest();
    generation++;
    loadingMore.value = false;
    moreError.value = null;
    if (!silent) {
      loading.value = true;
      items.value = [];
      next.value = null;
    }
    try {
      const page = await api.memories(query.value);
      if (!current()) return;
      items.value = page.items;
      next.value = page.next;
      paged.value = false;
      problem.value = null;
    } catch (e) {
      if (!current()) return;
      if (!silent || classify(e) === 'disconnected') {
        problem.value = { kind: classify(e), message: failureMessage(e) };
        if (!silent) items.value = [];
      }
    } finally {
      if (current()) loading.value = false;
    }
  }

  async function more(): Promise<void> {
    if (next.value === null || loadingMore.value) return;
    const gen = generation;
    const key = JSON.stringify(query.value);
    const run = ++moreRun;
    loadingMore.value = true;
    moreError.value = null;
    try {
      const page = await api.memories({ ...query.value, before: next.value });
      if (gen !== generation || key !== JSON.stringify(query.value)) return;
      const seen = new Set(items.value.map((r) => r.id));
      items.value = [...items.value, ...(page.items as Row[]).filter((r) => !seen.has(r.id))];
      next.value = page.next;
      paged.value = true;
    } catch (e) {
      if (gen !== generation || key !== JSON.stringify(query.value)) return;
      if (classify(e) === 'disconnected') problem.value = { kind: 'disconnected', message: failureMessage(e) };
      else moreError.value = failureMessage(e);
    } finally {
      if (run === moreRun) loadingMore.value = false;
    }
  }

  /** Switches kind (and drops the toggles that belong to the other kind). */
  function setKind(k: Kind): void {
    if (k === kind.value) return;
    kind.value = k;
    pinned.value = false;
    replaced.value = false;
    flagged.value = false;
    items.value = [];
    next.value = null;
  }

  /** Back to an unfiltered list of one kind, used when a link leads to an item the current list could not show. */
  function reset(k: Kind): void {
    text.value = '';
    q.value = '';
    project.value = '';
    pinned.value = false;
    replaced.value = false;
    flagged.value = false;
    kind.value = k;
    items.value = [];
    next.value = null;
  }

  /** Drops rows locally (after a forget), keeping whatever else was paged in. */
  function remove(ids: string[]): void {
    const gone = new Set(ids);
    const cursorGone = next.value !== null && items.value.some((r) => gone.has(r.id) && r.seq === next.value);
    items.value = items.value.filter((r) => !gone.has(r.id));
    if (!cursorGone) return;
    // The cursor row no longer exists, so "Load more" would fall back to a plain seq comparison; move it to the last row left.
    const last = items.value.at(-1);
    if (last) next.value = last.seq;
    else void load();
  }

  function patch(id: string, change: Partial<MemoryLine>): void {
    items.value = items.value.map((r) => (r.id === id ? { ...r, ...change } : r));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(text, (t) => {
    clearTimeout(timer);
    timer = setTimeout(() => (q.value = t.trim()), DEBOUNCE_MS);
  });
  onBeforeUnmount(() => clearTimeout(timer));
  // One reload per batch of changes (reset() changes several at once).
  watch([kind, q, project, pinned, replaced, flagged], () => void load());

  return { kind, text, q, project, pinned, replaced, flagged, items, next, loading, loadingMore, moreError, paged, problem, query, filtered, load, more, setKind, reset, patch, remove };
}
