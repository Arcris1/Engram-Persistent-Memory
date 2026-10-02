import type { Db } from '../storage/db.js';

/** §7: used_count only looks at accesses within this many days of `now`. */
const USED_WINDOW_DAYS = 180;
const MS_PER_DAY = 86_400_000;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export interface ImportanceInputs {
  /** Count of `accesses` rows with `used=1` within the last 180 days of `now`. */
  usedCount: number;
  /** True when a `marks` row `kind='pinned'` targets this (existing) claim. */
  pinned: boolean;
  /** True when any of the claim's source events has `kind='explicit_remember'`. */
  explicitRemember: boolean;
}

/**
 * §7 importance formula: `clamp(0.3 + 0.4*sigmoid(used_count - 2) + 0.3*pinned, 0, 1)`.
 *
 * Rules layered on top of the base formula:
 * - Pinned override: a pinned claim is always 1.0, regardless of the formula.
 * - explicit_remember floor: for an *unpinned* claim, if any source event is `explicit_remember`,
 *   the result is `max(formula, 0.8)` (§5B's old boost, kept as a floor rather than an addend).
 */
export function computeImportance(inputs: ImportanceInputs): number {
  if (inputs.pinned) return 1.0;
  const formula = clamp01(0.3 + 0.4 * sigmoid(inputs.usedCount - 2));
  return inputs.explicitRemember ? Math.max(formula, 0.8) : formula;
}

/**
 * Recomputes and persists `importance` for exactly the given claim ids (assumed to already exist --
 * callers that aren't sure should check first, same convention as the rest of control/*). Pulls
 * `usedCount`/`pinned`/`explicitRemember` fresh from the DB for each id, inside one transaction.
 */
export function recomputeImportanceFor(db: Db, claimIds: readonly string[], now: string): void {
  if (claimIds.length === 0) return;
  const windowStart = new Date(new Date(now).getTime() - USED_WINDOW_DAYS * MS_PER_DAY).toISOString();

  const usedCountStmt = db
    .prepare(`SELECT COUNT(*) FROM accesses WHERE target_id = ? AND used = 1 AND ts >= ? AND ts <= ?`)
    .pluck();
  const pinnedStmt = db.prepare(`SELECT 1 FROM marks WHERE target_id = ? AND kind = 'pinned' LIMIT 1`).pluck();
  const explicitStmt = db
    .prepare(
      `SELECT 1 FROM claim_sources cs JOIN events e ON e.id = cs.event_id
       WHERE cs.claim_id = ? AND e.kind = 'explicit_remember' LIMIT 1`,
    )
    .pluck();
  const update = db.prepare(`UPDATE claims SET importance = ? WHERE id = ?`);

  db.transaction(() => {
    for (const id of claimIds) {
      const usedCount = usedCountStmt.get(id, windowStart, now) as number;
      const pinned = Boolean(pinnedStmt.get(id));
      const explicitRemember = Boolean(explicitStmt.get(id));
      update.run(computeImportance({ usedCount, pinned, explicitRemember }), id);
    }
  })();
}

/** Recomputes `importance` for every claim in the database (used by `rebuild`/`engram maintain`). */
export function recomputeImportance(db: Db, now: string): void {
  const ids = db.prepare(`SELECT id FROM claims`).pluck().all() as string[];
  recomputeImportanceFor(db, ids, now);
}
