import { sha256 } from '../core/hash.js';
import { nowIso } from '../core/ids.js';
import type { Db } from '../storage/db.js';

export type TargetKind = 'event' | 'claim';

/**
 * D42/Phase 6 Task 2: claims have no `content_hash` column (unlike events, which already have one
 * for their own dedupe purposes) -- this is the one true definition of "what text a claim's stored
 * vector was derived from", used both to decide staleness (missingOrStale) and to stamp a freshly
 * embedded row (embedMissing / the MCP post-write hook). Order is fixed (subject, statement, object)
 * so every caller agrees on the same hash for the same claim.
 */
export function claimContentHash(subject: string, statement: string, object: string): string {
  return sha256(`${subject}\n${statement}\n${object}`);
}

/**
 * The text actually handed to the embedder for a claim: the statement is the claim itself, with
 * subject/object folded in for context (a bare statement like "Uses PostgreSQL." is ambiguous without
 * knowing who/what it's about).
 */
export function claimEmbedText(subject: string, statement: string, object: string): string {
  return `${statement}\n${subject}\n${object}`;
}

export interface EmbedTarget {
  kind: TargetKind;
  id: string;
  /** The exact text to hand to Embedder.embed() for this row. */
  text: string;
  /** The content hash this embedding should be stamped with once computed. */
  content_hash: string;
}

export interface UpsertEmbeddingInput {
  target_kind: TargetKind;
  target_id: string;
  model: string;
  content_hash: string;
  vec: Float32Array;
  created_at?: string;
}

/** Copies a Float32Array's bytes into a Buffer suitable for binding to a BLOB column. Always a copy
 * (never aliases the array's backing memory) so the caller's array can be mutated/GC'd freely afterward. */
function toBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

/** Reads a BLOB column's bytes out as a Float32Array: a zero-copy view when the Buffer is 4-byte
 * aligned, otherwise a copy. better-sqlite3's returned Buffer is not guaranteed aligned, so
 * constructing a Float32Array directly over its backing ArrayBuffer at a non-multiple-of-4 byteOffset
 * would throw (or silently misread on some engines). */
function toFloat32Array(buf: Buffer): Float32Array {
  return float32View(buf) ?? copyFloat32(buf);
}

/** Phase 6 review (perf): a zero-copy Float32Array over the BLOB's bytes when the Buffer happens to be
 * 4-byte aligned (and a whole number of floats); null otherwise, so callers fall back to a copy. Only
 * valid while the Buffer is alive and unmodified -- the search path consumes it immediately. */
export function float32View(buf: Buffer): Float32Array | null {
  if (buf.byteOffset % 4 !== 0 || buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function copyFloat32(buf: Buffer): Float32Array {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

/**
 * Inserts or replaces this target's embedding row (PRIMARY KEY (target_kind, target_id), so a second
 * call for the same target overwrites the vector/hash/model rather than erroring or duplicating).
 */
export function upsertEmbedding(db: Db, input: UpsertEmbeddingInput): void {
  db.prepare(
    `INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at)
     VALUES (@target_kind, @target_id, @model, @content_hash, @dim, @vec, @created_at)
     ON CONFLICT (target_kind, target_id) DO UPDATE SET
       model = excluded.model, content_hash = excluded.content_hash, dim = excluded.dim,
       vec = excluded.vec, created_at = excluded.created_at`,
  ).run({
    target_kind: input.target_kind,
    target_id: input.target_id,
    model: input.model,
    content_hash: input.content_hash,
    dim: input.vec.length,
    vec: toBuffer(input.vec),
    created_at: input.created_at ?? nowIso(),
  });
}

/**
 * Phase 6 review (forget race): embed() is async, so by the time a vector comes back the source row
 * may have been forgotten (or edited) by another process. This writes the vector inside ONE
 * synchronous transaction that re-checks the source still exists AND its current content hash equals
 * the hash that was embedded; otherwise it skips. Returns whether a row was written. Shared by the
 * backfill (`engram embed` / `maintain --embed`) and the MCP post-write hook so neither can resurrect
 * the embedding of forgotten content.
 */
export function upsertEmbeddingIfCurrent(db: Db, input: UpsertEmbeddingInput): boolean {
  // IMMEDIATE (like migrate()): this reads then writes, and SQLite does not invoke the busy handler on
  // a read->write lock upgrade, so a deferred transaction would throw SQLITE_BUSY at once under
  // contention instead of waiting out the busy timeout.
  return db.transaction((): boolean => {
    let current: string | null = null;
    if (input.target_kind === 'event') {
      current = (db.prepare(`SELECT content_hash FROM events WHERE id = ?`).pluck().get(input.target_id) as string | undefined) ?? null;
    } else {
      const c = db.prepare(`SELECT subject, statement, object FROM claims WHERE id = ?`).get(input.target_id) as
        | { subject: string; statement: string; object: string }
        | undefined;
      if (c) current = claimContentHash(c.subject, c.statement, c.object);
    }
    if (current === null || current !== input.content_hash) return false;
    upsertEmbedding(db, input);
    return true;
  }).immediate();
}

/**
 * Phase 6 review: deletes embedding rows whose source event/claim no longer exists (belt and braces
 * behind forget/reset and the guarded write above). Returns the number of rows removed.
 */
export function sweepOrphanEmbeddings(db: Db): number {
  return db.transaction((): number => {
    const e = db
      .prepare(`DELETE FROM embeddings WHERE target_kind = 'event' AND target_id NOT IN (SELECT id FROM events)`)
      .run().changes;
    const c = db
      .prepare(`DELETE FROM embeddings WHERE target_kind = 'claim' AND target_id NOT IN (SELECT id FROM claims)`)
      .run().changes;
    return e + c;
  })();
}

/**
 * Returns up to `limit` targets of the given kind that have no embedding row yet, or whose embedding
 * row's `content_hash` no longer matches the source's current content (the source was edited/
 * re-derived since it was last embedded). Events can filter this in SQL (content_hash is a real
 * column there); claims have no such column, so every claim's hash is (re)computed in JS and compared
 * -- fine at single-user scale (the same brute-force-is-fine reasoning as the hybrid search path).
 * `newestFirst` (Phase 6 review: the MCP search top-up) flips the order to newest-first; the default
 * oldest-first order the backfill CLI uses is unchanged.
 * Phase 6 review (model identity): when `model` (the current embedder's model string, which includes a
 * sha256 prefix of the model file) is given, a row embedded by a different model also counts as stale.
 */
export function missingOrStale(
  db: Db,
  kind: TargetKind,
  limit: number,
  newestFirst = false,
  model?: string,
): EmbedTarget[] {
  if (kind === 'event') {
    const rows = db
      .prepare(
        `SELECT e.id, e.content, e.content_hash
         FROM events e
         LEFT JOIN embeddings em ON em.target_kind = 'event' AND em.target_id = e.id
         WHERE em.target_id IS NULL OR em.content_hash != e.content_hash
            OR (@model IS NOT NULL AND em.model != @model)
         ORDER BY e.seq ${newestFirst ? 'DESC' : ''}
         LIMIT @limit`,
      )
      .all({ limit, model: model ?? null }) as { id: string; content: string; content_hash: string }[];
    return rows.map((r) => ({ kind: 'event', id: r.id, text: r.content, content_hash: r.content_hash }));
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.subject, c.statement, c.object, em.content_hash AS emb_hash, em.model AS emb_model
       FROM claims c
       LEFT JOIN embeddings em ON em.target_kind = 'claim' AND em.target_id = c.id
       ORDER BY c.seq ${newestFirst ? 'DESC' : ''}`,
    )
    .all() as { id: string; subject: string; statement: string; object: string; emb_hash: string | null; emb_model: string | null }[];

  const out: EmbedTarget[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const hash = claimContentHash(r.subject, r.statement, r.object);
    if (r.emb_hash === null || r.emb_hash !== hash || (model !== undefined && r.emb_model !== model)) {
      out.push({ kind: 'claim', id: r.id, text: claimEmbedText(r.subject, r.statement, r.object), content_hash: hash });
    }
  }
  return out;
}

/**
 * Counts what missingOrStale(db, kind, Infinity, false, model) would return, without materialising
 * rows: events are a pure SQL COUNT (never loads event content); claims have no stored hash, so only
 * their three short text columns are read and hashed in JS (no embed text is built).
 */
export function countMissingOrStale(db: Db, kind: TargetKind, model?: string): number {
  if (kind === 'event') {
    return db
      .prepare(
        `SELECT count(*) FROM events e
         LEFT JOIN embeddings em ON em.target_kind = 'event' AND em.target_id = e.id
         WHERE em.target_id IS NULL OR em.content_hash != e.content_hash
            OR (@model IS NOT NULL AND em.model != @model)`,
      )
      .pluck()
      .get({ model: model ?? null }) as number;
  }
  const rows = db
    .prepare(
      `SELECT c.subject, c.statement, c.object, em.content_hash AS emb_hash, em.model AS emb_model
       FROM claims c LEFT JOIN embeddings em ON em.target_kind = 'claim' AND em.target_id = c.id`,
    )
    .all() as { subject: string; statement: string; object: string; emb_hash: string | null; emb_model: string | null }[];
  let n = 0;
  for (const r of rows) {
    if (r.emb_hash === null || r.emb_hash !== claimContentHash(r.subject, r.statement, r.object) || (model !== undefined && r.emb_model !== model)) n++;
  }
  return n;
}

/**
 * Phase 6 review (Important #4): streams every stored vector of `kind` whose SOURCE row passes a
 * caller-supplied filter, joining embeddings to the source table in SQL instead of binding a
 * candidate id list (SQLite caps bound variables at 32,766). `where` / `params` are the very same
 * clauses (aliased `e.` for events, `c.` for claims) the FTS candidate query uses, so vector-only
 * candidates are filtered exactly like lexical ones. Vectors are passed to `fn` as short-lived views;
 * `fn` must not retain them. Phase 6 review (model identity): when `expect` is given, a stored vector
 * whose `dim` differs from `expect.dim`, or whose `model` differs from `expect.model`, is treated as
 * missing -- never compared, so a model swap can't yield garbage cosines.
 */
export function forEachFilteredVector(
  db: Db,
  kind: TargetKind,
  where: readonly string[],
  params: Record<string, unknown>,
  fn: (id: string, vec: Float32Array) => void,
  expect: { dim?: number; model?: string } = {},
): void {
  const [table, alias] = kind === 'event' ? ['events', 'e'] : ['claims', 'c'];
  const extra = where.map((w) => ` AND ${w}`).join('');
  const stmt = db
    .prepare(
      `SELECT em.target_id AS id, em.vec AS vec, em.dim AS dim, em.model AS model FROM embeddings em JOIN ${table} ${alias} ON ${alias}.id = em.target_id
       WHERE em.target_kind = '${kind}'${extra}`,
    );
  for (const row of stmt.iterate(params) as IterableIterator<{ id: string; vec: Buffer; dim: number; model: string }>) {
    if (expect.dim !== undefined && row.dim !== expect.dim) continue;
    if (expect.model !== undefined && row.model !== expect.model) continue;
    // a corrupt/truncated vector is skipped (treated as missing) so a hybrid search degrades, not fails
    if (row.vec.byteLength !== row.dim * 4) continue;
    fn(row.id, float32View(row.vec) ?? copyFloat32(row.vec));
  }
}

/**
 * Batch-loads stored vectors for a kind, keyed by target_id -- `ids` narrows to a candidate scope
 * (the shared brute-force-cosine search path loads only the pool it's scoring); omitted, every vector
 * of that kind is returned (used by the backfill CLI/maintain path, which has no candidate scope).
 */
export function loadVectors(db: Db, kind: TargetKind, ids?: string[]): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>();
  if (ids !== undefined && ids.length === 0) return map;
  const rows = (
    ids === undefined
      ? db.prepare(`SELECT target_id, vec FROM embeddings WHERE target_kind = ?`).all(kind)
      : db
          .prepare(
            `SELECT target_id, vec FROM embeddings WHERE target_kind = ? AND target_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(kind, ...ids)
  ) as { target_id: string; vec: Buffer }[];
  for (const row of rows) map.set(row.target_id, toFloat32Array(row.vec));
  return map;
}
