import { readClaim } from '../claims/claims.js';
import { nowIso } from '../core/ids.js';
import type { Db } from '../storage/db.js';
import { recomputeImportanceFor } from './importance.js';

export interface PinResult {
  id: string;
  pinned: boolean;
  importance: number;
}

function requireClaim(db: Db, id: string): void {
  if (!readClaim(db, id)) throw new Error(`no claim with id ${id}`);
}

/**
 * §6.9: pin a claim. The claim must exist (else throws). Upserts a `pinned` mark `(id, note,
 * created_at)` and sets `importance = 1.0` so the claim is always surfaced -- `selectProfile`
 * already orders pinned claims first.
 *
 * H4: pinning is also the normal way a claim restored by `engram import` (flagged `imported`,
 * excluded from the profile by `selectProfile` until pinned) earns its way into the profile -- the
 * `imported` flag is removed here, same as any other stale flag a user's explicit action resolves.
 */
export function pin(db: Db, id: string, note?: string): PinResult {
  requireClaim(db, id);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO marks (target_id, kind, note, created_at) VALUES (?, 'pinned', ?, ?)
       ON CONFLICT(target_id, kind) DO UPDATE SET note = excluded.note, created_at = excluded.created_at`,
    ).run(id, note ?? null, now);
    db.prepare(
      `UPDATE claims SET importance = 1.0,
         flags = COALESCE((SELECT json_group_array(value) FROM json_each(flags) WHERE value != 'imported'), '[]')
       WHERE id = ?`,
    ).run(id);
  })();
  return { id, pinned: true, importance: 1.0 };
}

/**
 * §6.9: unpin a claim. The claim must exist (else throws). Deletes the `pinned` mark (a no-op if it
 * was never pinned), then recomputes `importance` via the same §7 formula `memory_rebuild` uses
 * (src/control/importance.ts) -- so the rule lives in one place instead of being re-approximated
 * here. Without the pinned mark, a claim with no recent `used` accesses lands near the formula's
 * floor (~0.35); one citing an `explicit_remember` source is floored at 0.8.
 */
export function unpin(db: Db, id: string): PinResult {
  requireClaim(db, id);
  db.transaction(() => {
    db.prepare(`DELETE FROM marks WHERE target_id = ? AND kind = 'pinned'`).run(id);
    recomputeImportanceFor(db, [id], nowIso());
  })();
  const importance = readClaim(db, id)!.importance;
  return { id, pinned: false, importance };
}
