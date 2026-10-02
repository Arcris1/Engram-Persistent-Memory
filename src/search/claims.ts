import * as z from 'zod';
import { claimSources, rowToClaim, type RawClaimRow } from '../claims/claims.js';
import { SCOPES, type Scope } from '../core/types.js';
import type { Db } from '../storage/db.js';
import { cosineScoresFiltered, DEFAULT_TAU, fetchCandidates, gateAPassed, poolLimit, topKFromScores } from './candidates.js';
import { toFtsQuery } from './fts.js';
import type { Gate } from './gate.js';
import { rankHits } from './score.js';

const MS_PER_DAY = 86_400_000;

export const ClaimHitSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  statement: z.string(),
  scope: z.enum(SCOPES),
  confidence: z.number(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  recorded_at: z.string(),
  status: z.enum(['active', 'superseded', 'retracted']),
  project: z.string().nullable(),
  flags: z.array(z.string()),
  sources: z.array(z.object({ event_id: z.string(), excerpt: z.string().nullable() })),
  /** §7 composite score (keyword/auto mode); null in subject mode, which keeps its own ordering. */
  score: z.number().nullable(),
  /** Phase 6 (D42/hybrid): raw cosine similarity to the query embedding. OMITTED (not null) whenever no
   * cosine was computed for this hit (embedding disabled, keyword-only fallback, subject mode, or no
   * usable stored vector), so the disabled-path protocol output is unchanged from pre-Phase-6. */
  cosine: z.number().optional(),
});
export type ClaimHit = z.infer<typeof ClaimHitSchema>;

export interface ClaimSearchParams {
  query: string;
  mode: 'keyword' | 'subject';
  /** undefined = all projects; string = that project OR global (project IS NULL); null = global only. */
  project?: string | null;
  scope?: Scope[];
  include_superseded?: boolean;
  limit: number;
  /** D40 pre-registered precision gate (Phase 5 Task 3c). Default 'none' (production default; see
   * src/search/gate.ts). Only consulted by `searchClaimsRanked` (keyword/auto mode). */
  gate?: Gate;
  /** Phase 6 (D42/hybrid): the query's own embedding, when an embedder is available. `undefined`
   * (the default) keeps `searchClaimsRanked` byte-identical to pre-Phase-6 behaviour -- this is the
   * ONLY thing that switches hybrid ranking on. */
  queryVector?: Float32Array;
  /** Phase 6 review: the embedder's model string; stored vectors of any other model are treated as missing. */
  queryModel?: string;
  /** Phase 6 (D42/hybrid admission): cosine >= tau OR gate A admits a candidate. Only consulted when
   * `queryVector` is set; defaults to DEFAULT_TAU (src/search/candidates.ts) pending D43. */
  tau?: number;
}

/** Escape LIKE metacharacters so a user's query can't inject wildcards into the subject prefix match. */
function likePrefix(query: string): string {
  return `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function toHit(db: Db, raw: RawClaimRow, score: number | null = null, cosine: number | null = null): ClaimHit {
  const c = rowToClaim(raw);
  return {
    id: c.id,
    subject: c.subject,
    predicate: c.predicate,
    object: c.object,
    statement: c.statement,
    scope: c.scope,
    confidence: c.confidence,
    valid_from: c.valid_from,
    valid_to: c.valid_to,
    recorded_at: c.recorded_at,
    status: c.status,
    project: c.project,
    flags: c.flags,
    sources: claimSources(db, c.id),
    score,
    ...(cosine !== null ? { cosine } : {}),
  };
}

/** Shared WHERE-clause builder for `searchClaims` (keyword branch) and `searchClaimsRanked`. */
function buildClaimFilters(
  p: Pick<ClaimSearchParams, 'project' | 'scope' | 'include_superseded'>,
): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!p.include_superseded) where.push(`c.status = 'active'`);
  if (p.project === null) where.push('c.project IS NULL');
  else if (p.project !== undefined) {
    where.push('(c.project = @project OR c.project IS NULL)');
    params.project = p.project;
  }
  if (p.scope?.length) {
    const keys = p.scope.map((s, i) => {
      params[`scope${i}`] = s;
      return `@scope${i}`;
    });
    where.push(`c.scope IN (${keys.join(', ')})`);
  }
  return { where, params };
}

export function searchClaims(db: Db, p: ClaimSearchParams): ClaimHit[] {
  const { where, params } = buildClaimFilters(p);
  params.limit = p.limit;

  if (p.mode === 'keyword') {
    const match = toFtsQuery(p.query);
    if (!match) return [];
    params.match = match;
    const sql = `
      SELECT c.*
      FROM claims_fts JOIN claims c ON c.seq = claims_fts.rowid
      WHERE claims_fts MATCH @match ${where.map((w) => `AND ${w}`).join(' ')}
      ORDER BY bm25(claims_fts), c.recorded_at DESC
      LIMIT @limit`;
    return (db.prepare(sql).all(params) as RawClaimRow[]).map((r) => toHit(db, r));
  }

  params.prefix = likePrefix(p.query);
  where.push(`c.subject LIKE @prefix ESCAPE '\\'`);
  const sql = `
    SELECT c.*
    FROM claims c
    WHERE ${where.join(' AND ')}
    ORDER BY c.subject, c.predicate, c.recorded_at DESC
    LIMIT @limit`;
  return (db.prepare(sql).all(params) as RawClaimRow[]).map((r) => toHit(db, r));
}

/**
 * §7 composite-scored keyword search: fetches a candidate pool (max(limit*5, 50)) by bm25, resolves
 * each candidate's pinned status (`marks` kind='pinned', joined to this claim -- marks targeting
 * something else, e.g. an event or a `hash:` mark, never match since we only look up ids already in
 * the candidate set) and access history (`accesses` rows, never the `access_count` counter), scores
 * with `rankHits`, then cuts to `p.limit`. A pinned claim's importance is overridden to 1.0 per the
 * Phase 4 review ruling (§6.9 wins over §7 for pins) regardless of its stored `importance`.
 */
export function searchClaimsRanked(db: Db, p: ClaimSearchParams, now: string): ClaimHit[] {
  const match = toFtsQuery(p.query);
  if (!match) return [];

  const { where, params } = buildClaimFilters(p);
  params.match = match;
  const limit = poolLimit(p.limit);

  const sqlBase = `
    SELECT c.*, bm25(claims_fts) AS rank
    FROM claims_fts JOIN claims c ON c.seq = claims_fts.rowid
    WHERE claims_fts MATCH @match ${where.map((w) => `AND ${w}`).join(' ')}
    ORDER BY bm25(claims_fts), c.recorded_at DESC`;

  const gate = p.gate ?? 'none';
  const ftsRows = fetchCandidates<RawClaimRow & { rank: number }>({
    db,
    ftsTable: 'claims_fts',
    sqlBase,
    params,
    gate,
    query: p.query,
    limit,
  });

  let rows: (RawClaimRow & { rank: number | null })[];
  const cosineById = new Map<string, number>();

  if (p.queryVector === undefined) {
    rows = ftsRows;
  } else {
    // Phase 6 (D42/hybrid): candidates = FTS pool UNION top-K by cosine, each admitted only if
    // cosine >= tau OR it passes gate A (always gate A, independent of `gate` above). Admission is
    // applied to raw cosine BEFORE the scorable set is built, never to the composite score.
    const tau = p.tau ?? DEFAULT_TAU;
    for (const [id, cos] of cosineScoresFiltered(db, 'claim', where, params, p.queryVector, p.queryModel)) cosineById.set(id, cos);
    const topK = topKFromScores(cosineById, limit);

    const ftsIds = new Set(ftsRows.map((r) => r.id));
    const vectorOnlyIds = [...topK.keys()].filter((id) => !ftsIds.has(id));
    const vectorOnlyRows =
      vectorOnlyIds.length === 0
        ? []
        : (db
            .prepare(`SELECT c.* FROM claims c WHERE c.id IN (${vectorOnlyIds.map(() => '?').join(', ')})`)
            .all(...vectorOnlyIds) as RawClaimRow[]).map((r) => ({ ...r, rank: null as number | null }));

    const union = [...ftsRows.map((r) => ({ ...r, rank: r.rank as number | null })), ...vectorOnlyRows];
    const passedGateA = gateAPassed(db, 'claims_fts', union.map((r) => r.seq), p.query);
    rows = union.filter((r) => {
      const cos = cosineById.get(r.id);
      return (cos !== undefined && cos >= tau) || passedGateA.has(r.seq);
    });
  }
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(', ');

  const pinnedIds = new Set(
    (db.prepare(`SELECT target_id FROM marks WHERE kind = 'pinned' AND target_id IN (${placeholders})`)
      .all(...ids) as { target_id: string }[])
      .map((r) => r.target_id),
  );

  // J5: bounded to the last 365 days of `now` -- §7 activation is `ln(sum(age_j^-0.5))`, so an access
  // this old already contributes at most ~365^-0.5 ≈ 0.052 to that sum, negligible next to a handful
  // of recent accesses (and shrinking further for anything older still); fetching every access a
  // long-lived claim has ever had, forever, for no measurable scoring effect isn't worth the cost.
  const accessSinceIso = new Date(new Date(now).getTime() - 365 * MS_PER_DAY).toISOString();
  const accessByTarget = new Map<string, string[]>();
  for (const { target_id, ts } of db
    .prepare(`SELECT target_id, ts FROM accesses WHERE target_id IN (${placeholders}) AND ts >= ?`)
    .all(...ids, accessSinceIso) as { target_id: string; ts: string }[]) {
    const arr = accessByTarget.get(target_id);
    if (arr) arr.push(ts);
    else accessByTarget.set(target_id, [ts]);
  }

  const scorable = rows.map((row) => {
    const c = rowToClaim(row);
    const pinned = pinnedIds.has(c.id);
    const cosine = cosineById.get(c.id);
    return {
      id: c.id,
      rank: row.rank,
      cosine,
      ts: c.recorded_at,
      accessTs: accessByTarget.get(c.id) ?? [],
      importance: pinned ? 1.0 : c.importance,
      pinned,
      flags: c.flags,
      scope: c.scope,
      row,
    };
  });

  const ranked = rankHits(scorable, { now, requestedScopes: p.scope });
  return ranked.slice(0, p.limit).map((r) => toHit(db, r.row, r.score, r.cosine ?? null));
}
