import { recomputeImportanceFor } from '../control/importance.js';
import { newId, nowIso } from '../core/ids.js';
import type { Db } from '../storage/db.js';
import { readClaim } from './claims.js';

/** Log a search/read access against each claim and bump its access stats. */
export function logAccesses(db: Db, claimIds: string[], query: string | null): void {
  if (claimIds.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO accesses (id, ts, target_id, query, used) VALUES (?, ?, ?, ?, 0)`,
  );
  const bump = db.prepare(
    `UPDATE claims SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
  );
  db.transaction(() => {
    for (const id of claimIds) {
      const ts = nowIso();
      insert.run(newId(), ts, id, query);
      bump.run(ts, id);
    }
  })();
}

export interface FeedbackResult {
  updated: number;
}

/**
 * §6.8 `memory_feedback`: for each id that is an existing claim, set `used` on its most recent
 * `accesses` row (ordered by ts desc, id desc as a deterministic tiebreak), or insert one with
 * `query=NULL` if the claim has no access rows yet -- but only for positive feedback (`used=true`).
 * J1: negative feedback (`used=false`) on a claim with no access rows inserts nothing; fabricating an
 * access row the claim never actually had would hand it a fresh (if zeroed) `accesses` row that other
 * code (e.g. a future positive feedback's "most recent row" lookup) would otherwise treat as a real
 * access, and activation scoring must never be raised by negative feedback. Unknown ids are silently
 * skipped and never count toward `updated`. Importance for the (existing) affected claims is
 * recomputed afterward, per §7.
 */
export function recordFeedback(db: Db, ids: readonly string[], used: boolean, now: string): FeedbackResult {
  const usedInt = used ? 1 : 0;
  const findLatest = db
    .prepare(`SELECT id FROM accesses WHERE target_id = ? ORDER BY ts DESC, id DESC LIMIT 1`)
    .pluck();
  const updateAccess = db.prepare(`UPDATE accesses SET used = ? WHERE id = ?`);
  const insertAccess = db.prepare(
    `INSERT INTO accesses (id, ts, target_id, query, used) VALUES (?, ?, ?, NULL, ?)`,
  );

  const existingIds: string[] = [];
  db.transaction(() => {
    for (const id of ids) {
      if (!readClaim(db, id)) continue;
      existingIds.push(id);
      const latestAccessId = findLatest.get(id) as string | undefined;
      if (latestAccessId !== undefined) {
        updateAccess.run(usedInt, latestAccessId);
      } else if (used) {
        // J1: only positive feedback fabricates an access row when none exists yet; negative feedback
        // on a never-accessed claim has nothing to mark `used=0` and must not insert a fresh row either
        // (that row would itself raise activation -- see this function's doc comment).
        insertAccess.run(newId(), now, id, usedInt);
      }
    }
    recomputeImportanceFor(db, existingIds, now);
  })();

  return { updated: existingIds.length };
}
