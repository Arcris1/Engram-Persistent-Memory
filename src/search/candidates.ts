import { forEachFilteredVector, type TargetKind } from '../embed/store.js';
import type { Db } from '../storage/db.js';
import { gateNeed, gateTerms, rowsMeetingGate, type Gate } from './gate.js';
import { MIN_CANDIDATE_POOL } from './score.js';

/**
 * §7/Phase 5-6: the candidate pool fetched before scoring, per index -- `max(limit*5,
 * MIN_CANDIDATE_POOL)`. Previously duplicated inline in both searchClaimsRanked and
 * searchEventsRanked (noted as a Phase 5 review deferred-minor); single source of truth here.
 */
export function poolLimit(limit: number): number {
  return Math.max(limit * 5, MIN_CANDIDATE_POOL);
}

export interface FetchCandidatesOptions {
  db: Db;
  ftsTable: 'claims_fts' | 'events_fts';
  /** `SELECT ... FROM <table>_fts JOIN ... WHERE <table>_fts MATCH @match AND ... ORDER BY
   * bm25(<table>_fts), ...` -- no `LIMIT`; must select every column `rowsMeetingGate`'s caller needs
   * plus a `seq` column (the FTS table's content_rowid, D5). */
  sqlBase: string;
  params: Record<string, unknown>;
  gate: Gate;
  /** Raw query text (not the FTS-escaped match string) -- gate A/B compute their own terms from this
   * via gateTerms (src/search/gate.ts). */
  query: string;
  limit: number;
}

/**
 * D40's gate-aware FTS candidate-fetch logic (Phase 5 Task 3c), extracted here in Phase 6 Task 3 so
 * searchClaimsRanked/searchEventsRanked share one implementation instead of two copies.
 *
 * `gate: 'none'` (the unchanged production default): a plain bm25-ordered `LIMIT @limit`.
 * `gate: 'A' | 'B'`: the gate is a candidate filter applied BEFORE the pool limit, so it must see
 * every OR-match, not just the first `limit` of them -- fetch all matches (no LIMIT), filter by
 * per-term coverage, then apply the pool limit to the (already bm25/recency-ordered) survivors.
 */
export function fetchCandidates<R extends { seq: number }>(opts: FetchCandidatesOptions): R[] {
  const { db, ftsTable, sqlBase, params, gate, query, limit } = opts;
  if (gate === 'none') {
    return db.prepare(`${sqlBase} LIMIT @limit`).all({ ...params, limit }) as R[];
  }
  const allRows = db.prepare(sqlBase).all(params) as R[];
  const { terms, k } = gateTerms(query);
  const need = gateNeed(gate, k);
  const passed = rowsMeetingGate(db, ftsTable, allRows.map((r) => r.seq), terms, need);
  return allRows.filter((r) => passed.has(r.seq)).slice(0, limit);
}

/**
 * Phase 6 (D42/hybrid admission): the rows (by FTS rowid/seq) that pass the D40 gate A rule over
 * this query's content terms -- ALWAYS gate A specifically, independent of whatever `Gate` value
 * `fetchCandidates` above was called with (gate A/B stay an internal eval-only option on the plain
 * FTS pool; hybrid admission is pre-registered to use gate A only -- plan §"Hybrid ranking").
 */
export function gateAPassed(
  db: Db,
  ftsTable: 'claims_fts' | 'events_fts',
  seqs: readonly number[],
  query: string,
): Set<number> {
  const { terms, k } = gateTerms(query);
  return rowsMeetingGate(db, ftsTable, seqs, terms, gateNeed('A', k));
}

/**
 * Phase 6 (D42): raw cosine similarity -- dot(a,b) / (|a| * |b|) -- never min-max normalised (the
 * plan is explicit: admission and relevance both use raw cosine, clamped to [0,1] only at the point
 * of use). Vectors are stored L2-normalised (src/embed/store.ts), so in practice this reduces to a
 * dot product, but the full formula is computed anyway rather than assumed, so a vector that somehow
 * isn't unit-length (a future embedder, a corrupted row) still yields a mathematically correct
 * cosine rather than a silently wrong one. Mismatched lengths (shouldn't happen -- `dim` is part of
 * the stored row) compare only over the shorter vector's length. A zero vector has an undefined
 * cosine with anything; this returns 0 for that case rather than NaN.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  return cosineWithNorm(a, vectorNorm(a), b);
}

/** |v| accumulated in the same order cosineSimilarity always used (so results are bit-identical). */
function vectorNorm(a: Float32Array): number {
  let normA = 0;
  for (let i = 0; i < a.length; i++) normA += a[i]! * a[i]!;
  return Math.sqrt(normA);
}

/** cosineSimilarity with the query's norm hoisted out of the per-row loop (Phase 6 review perf). */
function cosineWithNorm(a: Float32Array, normA: number, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  // Mismatched lengths compare only over the shorter prefix, so the hoisted norm no longer applies.
  if (len !== a.length) normA = vectorNorm(a.subarray(0, len));
  let dot = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const y = b[i]!;
    dot += a[i]! * y;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * Math.sqrt(normB));
}

/**
 * Phase 6 (D42/hybrid): cosine-ranks every entry of `vectors` against `queryVector` and returns the
 * top `k` as a `Map<id, cosine>` (insertion order = descending cosine, though callers should treat it
 * as a lookup, not an ordered list). `k` is meant to be `poolLimit(limit)` -- the same shared pool
 * constant as the FTS side, per the plan ("top-K by cosine (K = shared pool constant)").
 */
export function topKByCosine(vectors: ReadonlyMap<string, Float32Array>, queryVector: Float32Array, k: number): Map<string, number> {
  const scored = Array.from(vectors.entries(), ([id, vec]) => [id, cosineSimilarity(queryVector, vec)] as const);
  scored.sort((a, b) => b[1] - a[1]);
  return new Map(scored.slice(0, Math.max(0, k)));
}

/**
 * Phase 6 (D42/D43): hybrid admission threshold, used when a caller asks for hybrid ranking
 * (`queryVector` set) without specifying `tau` explicitly. 0.45 is the value D43 froze from the
 * pre-registered dev-only τ sweep; do not retune it (held-out-2 was evaluated at this value, D44).
 */
export const DEFAULT_TAU = 0.45;

/**
 * Phase 6 review (Important #4): cosine of every stored vector (of `kind`) whose source row passes the
 * search filters, computed in one streaming pass -- vectors are never materialised into a Map, and no
 * id list is bound into SQL. Returns Map<id, raw cosine>. `where`/`params` come straight from the
 * search's own filter builder (buildEventFilters / buildClaimFilters).
 */
export function cosineScoresFiltered(
  db: Db,
  kind: TargetKind,
  where: readonly string[],
  params: Record<string, unknown>,
  queryVector: Float32Array,
  queryModel?: string,
): Map<string, number> {
  const scores = new Map<string, number>();
  const qNorm = vectorNorm(queryVector);
  forEachFilteredVector(
    db, kind, where, params, (id, vec) => scores.set(id, cosineWithNorm(queryVector, qNorm, vec)),
    { dim: queryVector.length, model: queryModel },
  );
  return scores;
}

/** Top `k` entries of a score map by descending cosine, as a Map (same contract as topKByCosine). */
export function topKFromScores(scores: ReadonlyMap<string, number>, k: number): Map<string, number> {
  const scored = Array.from(scores.entries());
  scored.sort((a, b) => b[1] - a[1]);
  return new Map(scored.slice(0, Math.max(0, k)));
}
