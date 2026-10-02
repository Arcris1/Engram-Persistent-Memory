import { rowToClaim, type ClaimRow, type RawClaimRow } from '../claims/claims.js';
import { rowToEvent, type EventRow, type RawEventRow } from '../events/events.js';
import type { Db } from '../storage/db.js';

export interface ListedClaim {
  seq: number;
  claim: ClaimRow;
}
export interface ListedEvent {
  seq: number;
  event: EventRow;
}

// SQLite's default host-parameter limit is 32766 on current builds but 999 on old ones; stay well under.
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** `project`: undefined = no filter, null = rows without a project, string = exact match. */
function projectClause(project: string | null | undefined, where: string[], params: unknown[]): void {
  if (project === undefined) return;
  if (project === null) where.push('project IS NULL');
  else {
    where.push('project = ?');
    params.push(project);
  }
}

/**
 * Keyset paging for a `<col> DESC, seq DESC` ordering: "after the row `beforeSeq`" means a smaller
 * (col, seq) pair, which stays correct when the time column is not monotonic in seq (imports,
 * transcript ingest). A cursor whose row has since been forgotten falls back to `seq < beforeSeq`.
 */
function beforeClause(db: Db, table: 'claims' | 'events', col: 'recorded_at' | 'ts', beforeSeq: number | undefined, where: string[], params: unknown[]): void {
  if (beforeSeq === undefined) return;
  const cur = db.prepare(`SELECT ${col} AS t FROM ${table} WHERE seq = ?`).get(beforeSeq) as { t: string } | undefined;
  if (!cur) {
    where.push('seq < ?');
    params.push(beforeSeq);
    return;
  }
  where.push(`(${col} < ? OR (${col} = ? AND seq < ?))`);
  params.push(cur.t, cur.t, beforeSeq);
}

export function listClaims(
  db: Db,
  o: { project?: string | null; includeSuperseded?: boolean; pinnedOnly?: boolean; limit: number; beforeSeq?: number },
): ListedClaim[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!o.includeSuperseded) where.push(`status = 'active'`);
  projectClause(o.project, where, params);
  if (o.pinnedOnly) where.push(`id IN (SELECT target_id FROM marks WHERE kind = 'pinned')`);
  beforeClause(db, 'claims', 'recorded_at', o.beforeSeq, where, params);
  const sql = `SELECT * FROM claims ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY recorded_at DESC, seq DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, o.limit) as RawClaimRow[];
  return rows.map((raw) => ({ seq: raw.seq, claim: rowToClaim(raw) }));
}

export function listEvents(db: Db, o: { project?: string | null; flaggedOnly?: boolean; limit: number; beforeSeq?: number }): ListedEvent[] {
  const where: string[] = [];
  const params: unknown[] = [];
  projectClause(o.project, where, params);
  if (o.flaggedOnly) where.push('json_array_length(flags) > 0');
  beforeClause(db, 'events', 'ts', o.beforeSeq, where, params);
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, seq DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, o.limit) as RawEventRow[];
  return rows.map((raw) => ({ seq: raw.seq, event: rowToEvent(raw) }));
}

/** Distinct non-null projects across claims and events, sorted. */
export function listProjects(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT project FROM claims WHERE project IS NOT NULL
       UNION SELECT project FROM events WHERE project IS NOT NULL
       ORDER BY project`,
    )
    .all() as { project: string }[];
  return rows.map((r) => r.project);
}

/** Which of these claim ids carry a `pinned` mark. */
export function pinnedIds(db: Db, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const part of chunks(ids)) {
    const rows = db
      .prepare(`SELECT target_id FROM marks WHERE kind = 'pinned' AND target_id IN (${part.map(() => '?').join(',')})`)
      .all(...part) as { target_id: string }[];
    for (const r of rows) out.add(r.target_id);
  }
  return out;
}

/** The claims with these ids (unknown ids are skipped); order follows the database, not `ids`. */
export function getClaims(db: Db, ids: readonly string[]): ClaimRow[] {
  const out: ClaimRow[] = [];
  for (const part of chunks(ids)) {
    const rows = db.prepare(`SELECT * FROM claims WHERE id IN (${part.map(() => '?').join(',')}) ORDER BY seq`).all(...part) as RawClaimRow[];
    for (const raw of rows) out.push(rowToClaim(raw));
  }
  return out;
}

/** The events with these ids (unknown ids are skipped); order follows the database, not `ids`. */
export function getEvents(db: Db, ids: readonly string[]): EventRow[] {
  const out: EventRow[] = [];
  for (const part of chunks(ids)) {
    const rows = db.prepare(`SELECT * FROM events WHERE id IN (${part.map(() => '?').join(',')}) ORDER BY seq`).all(...part) as RawEventRow[];
    for (const raw of rows) out.push(rowToEvent(raw));
  }
  return out;
}

/** Light per-claim lookup (access count, flags) for ids that came from search; unknown ids are absent. */
export function claimMeta(db: Db, ids: readonly string[]): Map<string, { accessCount: number; flags: string[] }> {
  const out = new Map<string, { accessCount: number; flags: string[] }>();
  for (const part of chunks(ids)) {
    const rows = db
      .prepare(`SELECT id, access_count, flags FROM claims WHERE id IN (${part.map(() => '?').join(',')})`)
      .all(...part) as { id: string; access_count: number; flags: string }[];
    for (const r of rows) out.set(r.id, { accessCount: r.access_count, flags: JSON.parse(r.flags) as string[] });
  }
  return out;
}

/** Number of cited source events per claim id; every requested id is present (0 when none). */
export function sourceCounts(db: Db, claimIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>(claimIds.map((id) => [id, 0]));
  for (const part of chunks(claimIds)) {
    const rows = db
      .prepare(`SELECT claim_id, COUNT(*) AS n FROM claim_sources WHERE claim_id IN (${part.map(() => '?').join(',')}) GROUP BY claim_id`)
      .all(...part) as { claim_id: string; n: number }[];
    for (const r of rows) out.set(r.claim_id, r.n);
  }
  return out;
}

function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Captured events per local calendar day: exactly `days` entries, oldest first, ending with `now`'s day. */
export function activityByDay(db: Db, days: number, now: Date): { day: string; count: number }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const counts = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    counts.set(localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)), 0);
  }
  const rows = db.prepare('SELECT ts FROM events WHERE ts >= ?').all(start.toISOString()) as { ts: string }[];
  for (const { ts } of rows) {
    const day = localDay(new Date(ts));
    if (counts.has(day)) counts.set(day, counts.get(day)! + 1);
  }
  return [...counts].map(([day, count]) => ({ day, count }));
}

export function countEmbeddings(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
}
