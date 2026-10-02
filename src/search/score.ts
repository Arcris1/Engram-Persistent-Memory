import type { Scope } from '../core/types.js';

/**
 * §7 retrieval scoring. Pure functions over plain data -- no DB access here, so every component is
 * independently testable against hand-computed values. `rankHits` is the orchestrator events.ts /
 * claims.ts call once they've fetched the raw ingredients (bm25 rank, access timestamps, pinned
 * flag, importance) for a candidate pool.
 *
 * score = 0.45*bm25_norm + 0.20*recency + 0.15*act_norm + 0.15*importance + 0.05*pin
 *   bm25_norm  = 1 - (r - r_min) / (r_max - r_min + eps)      -- within the candidate set
 *   recency    = exp(-deltaDays / 30)
 *   activation = ln( sum( age_j ^ -0.5 ) ), age in days, floored at 1/24 day (1 hour); 0 if no
 *                accesses; negative values (very old / few accesses) clamp to 0
 *   act_norm   = clamp(activation / 3, 0, 1)
 * then penalties are added (they're already negative): instruction_like -0.3, scope != 'fact' -0.2
 * unless the caller's scope filter asked for that scope.
 */

const MS_PER_DAY = 86_400_000;
const EPSILON = 1e-9;
const MIN_ACCESS_AGE_DAYS = 1 / 24; // 1 hour floor, per §7

/** §7: candidate pool fetched before scoring, per index (`max(limit*5, MIN_CANDIDATE_POOL)`). J5:
 * single source of truth -- previously duplicated as a private constant in both src/search/claims.ts
 * and src/search/events.ts. */
export const MIN_CANDIDATE_POOL = 50;

const WEIGHTS = {
  bm25: 0.45,
  recency: 0.2,
  activation: 0.15,
  importance: 0.15,
  pin: 0.05,
} as const;

const PENALTY_INSTRUCTION_LIKE = -0.3;
const PENALTY_NON_FACT_SCOPE = -0.2;

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / MS_PER_DAY;
}

/** J2: any non-finite (NaN/±Infinity) component collapses to 0 rather than poisoning the composite
 * score or (worse) the sort comparator. Applied at the boundary of every §7 component below. */
function finiteOr0(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/**
 * §7: normalise raw FTS5 bm25 ranks (lower = better match) to 0..1 (higher = better) within the
 * given candidate set. A single candidate, or a set where every rank ties, normalises to 1 for all
 * (the epsilon in the denominator keeps 0/eps = 0, so 1 - 0 = 1).
 *
 * J2: a non-finite rank (shouldn't happen from FTS5's own bm25(), but untrusted/corrupted data is
 * defended against everywhere else in this file too) is excluded from the rMin/rMax bounds -- one bad
 * rank must not distort every other candidate's normalisation -- and its own normalised value is 0.
 *
 * Phase 6 (D42/hybrid): `rank` is `null` for a vector-only candidate (admitted by cosine/gate A but
 * never matched by the FTS query, so it has no bm25 rank at all) -- treated exactly like a non-finite
 * rank: excluded from the rMin/rMax bounds, normalised value 0. An all-number input (no nulls, the
 * disabled/pre-Phase-6 path) behaves byte-identically to before.
 */
export function bm25Norm(ranks: readonly (number | null)[]): number[] {
  if (ranks.length === 0) return [];
  const finite = ranks.filter((r): r is number => r !== null && Number.isFinite(r));
  const rMin = finite.length ? Math.min(...finite) : 0;
  const rMax = finite.length ? Math.max(...finite) : 0;
  const span = rMax - rMin + EPSILON;
  return ranks.map((r) => (r !== null && Number.isFinite(r) ? finiteOr0(1 - (r - rMin) / span) : 0));
}

/**
 * §7: exp(-deltaDays / 30), deltaDays = days elapsed between `ts` and `now`.
 *
 * J2: deltaDays is clamped to >= 0 first -- a `ts` after `now` (a future-dated row, e.g. corrupted
 * data or an untrusted import bypassing normal validation) must not make this candidate look *better*
 * than a just-now one via exp() of a negative delta; it caps out at the same recency=1 a just-now
 * access gets. An invalid `ts` (unparseable date -> NaN) falls through to 0 via finiteOr0.
 */
export function recency(ts: string, now: string): number {
  const deltaDays = Math.max(0, daysBetween(ts, now));
  return finiteOr0(Math.exp(-deltaDays / 30));
}

/**
 * §7 ACT-R base-level activation: ln(sum(age_j ^ -0.5)) over access ages in days, age floored at
 * 1/24 day so a just-now access doesn't blow up the sum. No accesses -> 0. A negative result (old
 * or sparse accesses) clamps to 0 -- activation never makes a candidate look worse than unvisited.
 *
 * J2: an individual access whose age computes to a non-finite value (an invalid/corrupted
 * `accesses.ts`) contributes 0 to the sum rather than turning the whole sum (and so every other, valid
 * access) into NaN; the final result is also finiteOr0'd as a last-resort guard.
 */
export function activation(accessTs: readonly string[], now: string): number {
  if (accessTs.length === 0) return 0;
  const sum = accessTs.reduce((acc, ts) => {
    const age = Math.max(daysBetween(ts, now), MIN_ACCESS_AGE_DAYS);
    const term = age ** -0.5;
    return Number.isFinite(term) ? acc + term : acc;
  }, 0);
  const raw = Math.log(sum);
  return raw > 0 ? finiteOr0(raw) : 0;
}

export interface CompositeParts {
  /** 0..1, already normalised (see bm25Norm). */
  bm25: number;
  /** 0..1 (typically), from recency(). */
  recency: number;
  /** Raw activation (see activation()); act_norm = clamp(activation/3, 0, 1) is applied here. */
  activation: number;
  /** 0..1 claim/event importance (pinned claims are overridden to 1.0 by the caller before this). */
  importance: number;
  /** 1 if pinned, else 0. */
  pin: number;
}

/** §7: the weighted sum, before penalties. */
export function composite(parts: CompositeParts): number {
  const actNorm = Math.min(1, Math.max(0, parts.activation / 3));
  return (
    WEIGHTS.bm25 * parts.bm25 +
    WEIGHTS.recency * parts.recency +
    WEIGHTS.activation * actNorm +
    WEIGHTS.importance * parts.importance +
    WEIGHTS.pin * parts.pin
  );
}

export interface PenalizableItem {
  flags: readonly string[];
  scope: Scope;
}

/**
 * §7 penalties (returned as a negative number to add to the composite score):
 * - `instruction_like` flag: -0.3
 * - scope != 'fact': -0.2, unless the caller's `requestedScopes` filter explicitly asked for that
 *   scope (i.e. the caller opted in, so it shouldn't also be penalised for showing up).
 */
export function penalties(item: PenalizableItem, requestedScopes?: readonly Scope[]): number {
  let penalty = 0;
  if (item.flags.includes('instruction_like')) penalty += PENALTY_INSTRUCTION_LIKE;
  if (item.scope !== 'fact' && !requestedScopes?.includes(item.scope)) penalty += PENALTY_NON_FACT_SCOPE;
  return penalty;
}

export interface ScorableHit extends PenalizableItem {
  id: string;
  /** Raw bm25 rank from FTS5 (lower = better); `null` for a vector-only hybrid candidate that never
   * matched the FTS query (Phase 6/D42) -- see bm25Norm's doc comment. */
  rank: number | null;
  /** Timestamp recency is measured from (events.ts / claims.recorded_at). */
  ts: string;
  /** Access timestamps feeding activation; events always pass []. */
  accessTs: readonly string[];
  /** Resolved importance (pinned claims already overridden to 1.0 by the caller). */
  importance: number;
  pinned: boolean;
  /** Phase 6 (D42/hybrid): raw cosine similarity to the query embedding, when both the row and the
   * query were embedded. `undefined` on the disabled path (no embedder) and for any admitted row
   * that has no stored vector of its own -- `rankHits` falls back to the bm25-only relevance term for
   * those, exactly as before Phase 6. */
  cosine?: number;
}

export interface RankOptions {
  now: string;
  requestedScopes?: readonly Scope[];
}

/**
 * Attaches a `score` to each item per §7 and sorts desc, breaking ties by `id` ascending (ULIDs
 * sort chronologically, so this is also a stable, deterministic secondary order).
 *
 * J2: `importance` is clamped to [0,1] here (a stored value out of range -- or non-finite -- is
 * untrusted the same way an imported/corrupted row's other fields are) and the final `score` is
 * guaranteed finite (any non-finite result, however it arose, becomes 0) -- the sort comparator below
 * must never see NaN, which breaks Array.prototype.sort's ordering guarantees entirely.
 *
 * Phase 6 (D42/hybrid): this is the single place that computes the §7 bm25 term when hybrid ranking
 * is active. For an item carrying `cosine` (its own vector was loaded and compared to the query's),
 * `relevance = 0.5*bm25_norm + 0.5*clamp(cosine, 0, 1)` -- raw cosine, never min-max normalised,
 * clamped only to guard against a malformed/out-of-range stored value -- replaces the plain
 * `bm25_norm` that feeds the existing 0.45 §7 weight; every other component (recency/activation/
 * importance/pin/penalties) is untouched. An item with no `cosine` (disabled path -- no embedder at
 * all -- or an admitted hit with no vector of its own) uses `bm25_norm` alone, byte-identical to
 * pre-Phase-6 behaviour.
 */
export function rankHits<T extends ScorableHit>(items: readonly T[], opts: RankOptions): (T & { score: number })[] {
  const norms = bm25Norm(items.map((i) => i.rank));
  const scored = items.map((item, i) => {
    const importance = Number.isFinite(item.importance) ? Math.min(1, Math.max(0, item.importance)) : 0;
    const bm25Term =
      item.cosine === undefined ? norms[i]! : 0.5 * norms[i]! + 0.5 * Math.min(1, Math.max(0, item.cosine));
    const rawScore =
      composite({
        bm25: bm25Term,
        recency: recency(item.ts, opts.now),
        activation: activation(item.accessTs, opts.now),
        importance,
        pin: item.pinned ? 1 : 0,
      }) + penalties(item, opts.requestedScopes);
    return { ...item, score: finiteOr0(rawScore) };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return scored;
}
