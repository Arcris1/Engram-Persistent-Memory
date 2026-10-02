import { reactive } from 'vue';
import { api } from './api';
import { useLatest } from './latest';

/** Small cross-view state: the memory count the rail shows and whether capture is paused (both from the overview). */
export const shared = reactive<{ memories: number | null; paused: boolean }>({ memories: null, paused: false });

const latest = useLatest();

/** Refreshes `shared` from the overview. Failures are ignored: the views show their own errors. */
export async function loadShared(): Promise<void> {
  const current = latest();
  try {
    const o = await api.overview();
    if (!current()) return;
    shared.memories = o.stats.claims.active;
    shared.paused = o.paused;
  } catch {
    /* keep what we had */
  }
}
