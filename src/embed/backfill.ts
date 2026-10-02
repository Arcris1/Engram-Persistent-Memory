import type { Db } from '../storage/db.js';
import type { Embedder } from './embedder.js';
import { missingOrStale, upsertEmbeddingIfCurrent, type TargetKind } from './store.js';

export interface EmbedMissingOptions {
  /** Max rows embedded per kind (not a combined total) -- default matches `engram embed`'s own default. */
  limit?: number;
  kinds?: readonly TargetKind[];
}

export interface EmbedMissingResult {
  embedded: number;
  by_kind: Record<TargetKind, number>;
}

const DEFAULT_LIMIT = 500;
const ALL_KINDS: readonly TargetKind[] = ['event', 'claim'];

/**
 * `engram embed` / `engram maintain --embed`'s shared batch worker: for each requested kind, finds up
 * to `limit` rows with no embedding yet (or a stale one -- source content changed since it was last
 * embedded) and embeds+stores them one at a time. Never imports the embedder itself -- the caller
 * (the CLI command) already resolved one via loadEmbedder before calling this.
 */
export async function embedMissing(
  db: Db,
  embedder: Embedder,
  opts: EmbedMissingOptions = {},
): Promise<EmbedMissingResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const kinds = opts.kinds ?? ALL_KINDS;
  const byKind: Record<TargetKind, number> = { event: 0, claim: 0 };

  for (const kind of kinds) {
    const targets = missingOrStale(db, kind, limit, false, embedder.model);
    for (const target of targets) {
      const [vec] = await embedder.embed([target.text]);
      // Phase 6 review: guarded write -- skipped if the row was forgotten/edited while embed() ran.
      const written = upsertEmbeddingIfCurrent(db, {
        target_kind: target.kind,
        target_id: target.id,
        model: embedder.model,
        content_hash: target.content_hash,
        vec: vec!,
      });
      if (!written) continue;
      byKind[kind]++;
    }
  }

  return { embedded: byKind.event + byKind.claim, by_kind: byKind };
}

/**
 * Loops embedMissing in batches of DEFAULT_LIMIT per kind until nothing more can be embedded (or the
 * optional total `limit` is reached). Shared by `engram embed` and `engram maintain --embed` so both do
 * the same backfill-to-completion. A batch that embeds nothing (e.g. every guarded write skipped
 * because the row was forgotten/edited meanwhile) ends the loop, so it cannot spin.
 */
export async function embedAll(
  db: Db,
  embedder: Embedder,
  opts: { limit?: number } = {},
): Promise<EmbedMissingResult> {
  const cap = opts.limit ?? Number.POSITIVE_INFINITY;
  const byKind: Record<TargetKind, number> = { event: 0, claim: 0 };
  let total = 0;
  for (let progressed = true; progressed && total < cap; ) {
    progressed = false;
    for (const kind of ALL_KINDS) {
      if (total >= cap) break;
      const r = await embedMissing(db, embedder, { kinds: [kind], limit: Math.min(DEFAULT_LIMIT, cap - total) });
      byKind[kind] += r.embedded;
      total += r.embedded;
      if (r.embedded > 0) progressed = true;
    }
  }
  return { embedded: total, by_kind: byKind };
}
