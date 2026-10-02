import type { Db } from '../storage/db.js';
import type { Embedder } from './embedder.js';
import { missingOrStale, upsertEmbeddingIfCurrent, type EmbedTarget } from './store.js';

/** Phase 6 review (Important #5): max rows embedded by one search's lazy top-up. */
export const TOPUP_LIMIT = 32;

/**
 * The plan's "lazily before a search, for missing rows, bounded": embeds up to `max` missing/stale
 * events+claims, newest first (events and claims interleaved so neither starves the other), using the
 * same guarded write as the backfill. Exists because hook-written events (prompts/transcripts) never
 * pass through the MCP post-write hook and would otherwise stay vector-less until a manual
 * `engram embed`. Never throws -- any failure is one stderr line (no content) and the search carries
 * on. Called only from the MCP server (never a hook), and only with a loaded embedder.
 */
export async function topUpEmbeddings(db: Db, embedder: Embedder, max: number = TOPUP_LIMIT): Promise<number> {
  let done = 0;
  try {
    const events = missingOrStale(db, 'event', max, true, embedder.model);
    const claims = missingOrStale(db, 'claim', max, true, embedder.model);
    const queue: EmbedTarget[] = [];
    for (let i = 0; i < Math.max(events.length, claims.length); i++) {
      if (events[i]) queue.push(events[i]!);
      if (claims[i]) queue.push(claims[i]!);
    }
    for (const t of queue.slice(0, max)) {
      const [vec] = await embedder.embed([t.text]);
      const written = upsertEmbeddingIfCurrent(db, {
        target_kind: t.kind,
        target_id: t.id,
        model: embedder.model,
        content_hash: t.content_hash,
        vec: vec!,
      });
      if (written) done++;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`engram: lazy embedding top-up failed, continuing search (${message})\n`);
  }
  return done;
}
