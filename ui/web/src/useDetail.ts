import { ref } from 'vue';
import type { Detail } from '../../server/types';
import { api, ApiFailure } from './api';
import { useToasts } from './format';
import { useLatest } from './latest';
import { classify, failureMessage, type Problem } from './load';
import { shared } from './store';

export function detailId(d: Detail): string {
  return d.kind === 'memory' ? d.memory.id : d.message.id;
}

export interface DetailHooks {
  /** The item turned out not to exist (404): the list should refetch. */
  onGone(): void;
  /** A memory's pin state changed: the list row should follow. */
  onPinned(id: string, pinned: boolean): void;
  /** The kind of item `id` is when it is known without its detail (e.g. from the list); null when unknown. */
  kindHint(id: string): 'memory' | 'message' | null;
}

/** The detail side of the Memories screen: loading one item, the gone/error states, pin and unpin. */
export function useDetail(hooks: DetailHooks) {
  const { show } = useToasts();
  const detail = ref<Detail | null>(null);
  const loading = ref(false);
  const problem = ref<{ kind: Problem; message: string } | null>(null);
  const gone = ref<'memory' | 'message' | 'unknown' | null>(null);
  const pinning = ref(false);
  const newest = useLatest();

  function markGone(id?: string): void {
    gone.value = detail.value?.kind ?? (id ? hooks.kindHint(id) : null) ?? 'unknown';
    detail.value = null;
    hooks.onGone();
  }

  async function open(id: string | null, silent = false): Promise<void> {
    const current = newest();
    if (!id) {
      detail.value = null;
      gone.value = null;
      problem.value = null;
      loading.value = false;
      return;
    }
    if (!silent) {
      loading.value = true;
      gone.value = null;
      problem.value = null;
      if (detail.value && detailId(detail.value) !== id) detail.value = null;
    }
    try {
      const d = await api.detail(id);
      if (!current()) return;
      detail.value = d;
      gone.value = null;
      problem.value = null;
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiFailure && e.code === 'not_found') markGone(id);
      else if (!silent || classify(e) === 'disconnected') problem.value = { kind: classify(e), message: failureMessage(e) };
    } finally {
      if (current()) loading.value = false;
    }
  }

  async function togglePin(): Promise<void> {
    const d = detail.value;
    if (!d || d.kind !== 'memory' || pinning.value || shared.paused) return;
    const id = d.memory.id;
    pinning.value = true;
    const same = (): boolean => detail.value?.kind === 'memory' && detail.value.memory.id === id;
    try {
      const r = d.memory.pinned ? await api.unpin(id) : await api.pin(id);
      if (same() && detail.value?.kind === 'memory') detail.value = { ...detail.value, memory: { ...detail.value.memory, pinned: r.pinned } };
      hooks.onPinned(id, r.pinned);
      if (same()) show(r.pinned ? 'Pinned' : 'Unpinned');
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'not_found') {
        if (same()) markGone(id);
        else hooks.onGone(); // the detail moved on: only the list needs to follow
      } else if (e instanceof ApiFailure && e.code === 'paused') {
        shared.paused = true;
        show('engram is paused. Resume capture to pin.');
      } else if (classify(e) === 'disconnected') {
        if (same()) problem.value = { kind: 'disconnected', message: '' };
      } else if (same()) show(failureMessage(e));
    } finally {
      pinning.value = false;
    }
  }

  return { detail, loading, problem, gone, pinning, open, togglePin, markGone };
}
