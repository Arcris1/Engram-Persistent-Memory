import { readClaim } from '../claims/claims.js';
import { readEvent } from '../events/events.js';
import type { Db } from '../storage/db.js';
import type { Embedder } from './embedder.js';
import { claimContentHash, claimEmbedText, upsertEmbeddingIfCurrent } from './store.js';

/**
 * The MCP server's post-write embedding hook (D42/Phase 6 Task 2): called after `memory_record` /
 * `memory_claim_upsert` has already committed a new or merged row, for exactly that one row. Never
 * throws and never imports the embedder itself (the caller already resolved `embedder` once per
 * process via ToolContext.embedder()) -- a `null` embedder (disabled/misconfigured) is a silent no-op,
 * and any other failure (a flaky/slow model call, a closed db, anything) is caught and logged to
 * stderr (never stdout -- that's the MCP protocol channel) rather than ever failing the tool call that
 * triggered it. Bounded cost: exactly one embed() call for this one row, never a rescan of anything else.
 */
export async function embedAfterWrite(
  db: Db,
  embedder: Embedder | null,
  target: { kind: 'event' | 'claim'; id: string },
): Promise<void> {
  if (!embedder) return;
  try {
    if (target.kind === 'event') {
      const event = readEvent(db, target.id);
      if (!event) return;
      const [vec] = await embedder.embed([event.content]);
      upsertEmbeddingIfCurrent(db, {
        target_kind: 'event',
        target_id: event.id,
        model: embedder.model,
        content_hash: event.content_hash,
        vec: vec!,
      });
    } else {
      const claim = readClaim(db, target.id);
      if (!claim) return;
      const hash = claimContentHash(claim.subject, claim.statement, claim.object);
      const [vec] = await embedder.embed([claimEmbedText(claim.subject, claim.statement, claim.object)]);
      upsertEmbeddingIfCurrent(db, { target_kind: 'claim', target_id: claim.id, model: embedder.model, content_hash: hash, vec: vec! });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`engram: post-write embedding failed (${target.kind} ${target.id}): ${message}\n`);
  }
}
