import { createHash } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { recomputeImportance } from './importance.js';

export interface RebuildResult {
  fts_checksum: string;
  importance_checksum: string;
}

/**
 * HANDOFF §4: "`engram rebuild` must produce identical `*_fts` contents from `events` + `claims`
 * (test by checksum)." Hashes `SELECT rowid, * FROM events_fts ORDER BY rowid` then the same query
 * against `claims_fts`, in that fixed order, so the result is deterministic across runs as long as
 * the underlying `events`/`claims` content is unchanged.
 */
function ftsChecksum(db: Db): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(db.prepare(`SELECT rowid, * FROM events_fts ORDER BY rowid`).all()));
  hash.update(JSON.stringify(db.prepare(`SELECT rowid, * FROM claims_fts ORDER BY rowid`).all()));
  return hash.digest('hex');
}

/** sha256 over every claim id + its importance, ordered by id -- deterministic across runs. */
function importanceChecksum(db: Db): string {
  const rows = db.prepare(`SELECT id, importance FROM claims ORDER BY id`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * §6.11 `memory_rebuild` / `engram rebuild`: rebuilds both FTS5 external-content indexes from their
 * source tables (`events`, `claims`) and recomputes `importance` for every claim, then returns
 * checksums over both so callers (and the Phase 5 acceptance test) can confirm the rebuild is
 * idempotent and content-addressed rather than order- or history-dependent.
 */
export function rebuild(db: Db, now: string): RebuildResult {
  db.transaction(() => {
    db.prepare(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`).run();
    db.prepare(`INSERT INTO claims_fts(claims_fts) VALUES('rebuild')`).run();
    recomputeImportance(db, now);
  })();
  return { fts_checksum: ftsChecksum(db), importance_checksum: importanceChecksum(db) };
}
