import * as z from 'zod';
import { truncateUtf16 } from '../core/text.js';
import { EVENT_KINDS, ROLES, SCOPES, type Scope } from '../core/types.js';
import { rowToEvent, type RawEventRow } from '../events/events.js';
import type { Db } from '../storage/db.js';
import { cosineScoresFiltered, DEFAULT_TAU, fetchCandidates, gateAPassed, poolLimit, topKFromScores } from './candidates.js';
import type { Gate } from './gate.js';
import { rankHits } from './score.js';
import { toFtsQuery } from './fts.js';
import { normalizeBound } from './time.js';

/** D15: keep a 50-hit result inside the MCP tool-output budget. */
export const RESULT_CONTENT_CHARS = 1000;

export const EventHitSchema = z.object({
  id: z.string(),
  ts: z.string(),
  session_id: z.string(),
  project: z.string().nullable(),
  role: z.enum(ROLES),
  kind: z.enum(EVENT_KINDS),
  scope: z.enum(SCOPES),
  flags: z.array(z.string()),
  content: z.string(),
  content_truncated: z.boolean(),
  snippet: z.string().nullable(),
  /** §7 composite score (keyword/auto mode); null in time mode, which keeps its own ordering. */
  score: z.number().nullable(),
  /** Phase 6 (D42/hybrid): raw cosine similarity to the query embedding. OMITTED (not null) whenever no
   * cosine was computed for this hit (embedding disabled, keyword-only fallback, time mode, or no
   * usable stored vector), so the disabled-path protocol output is unchanged from pre-Phase-6. */
  cosine: z.number().optional(),
});
export type EventHit = z.infer<typeof EventHitSchema>;

export interface EventSearchParams {
  query?: string;
  mode: 'keyword' | 'time';
  since?: string;
  until?: string;
  /** undefined = all projects; null = events with no project. */
  project?: string | null;
  scope?: Scope[];
  limit: number;
  /** D40 pre-registered precision gate (Phase 5 Task 3c). Default 'none' (production default; see
   * src/search/gate.ts). Only consulted by `searchEventsRanked` (keyword/auto mode). */
  gate?: Gate;
  /** Phase 6 (D42/hybrid): the query's own embedding, when an embedder is available. `undefined`
   * (the default) keeps `searchEventsRanked` byte-identical to pre-Phase-6 behaviour. */
  queryVector?: Float32Array;
  /** Phase 6 review: the embedder's model string; stored vectors of any other model are treated as missing. */
  queryModel?: string;
  /** Phase 6 (D42/hybrid admission): cosine >= tau OR gate A admits a candidate. Only consulted when
   * `queryVector` is set; defaults to DEFAULT_TAU (src/search/candidates.ts) pending D43. */
  tau?: number;
}

type HitRow = RawEventRow & { snippet: string | null };

function toHit(row: HitRow, score: number | null = null, cosine: number | null = null): EventHit {
  const e = rowToEvent(row);
  const truncated = truncateUtf16(e.content, RESULT_CONTENT_CHARS);
  return {
    id: e.id,
    ts: e.ts,
    session_id: e.session_id,
    project: e.project,
    role: e.role,
    kind: e.kind,
    scope: e.scope,
    flags: e.flags,
    content: truncated,
    content_truncated: e.content.length > RESULT_CONTENT_CHARS,
    snippet: row.snippet,
    score,
    ...(cosine !== null ? { cosine } : {}),
  };
}

/** Shared WHERE-clause builder for `searchEvents` (keyword branch) and `searchEventsRanked`. */
function buildEventFilters(p: Pick<EventSearchParams, 'since' | 'until' | 'project' | 'scope'>): {
  where: string[];
  params: Record<string, unknown>;
} {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (p.since) {
    where.push('e.ts >= @since');
    params.since = normalizeBound(p.since, 'start');
  }
  if (p.until) {
    where.push('e.ts <= @until');
    params.until = normalizeBound(p.until, 'end');
  }
  if (p.project === null) where.push('e.project IS NULL');
  else if (p.project !== undefined) {
    where.push('e.project = @project');
    params.project = p.project;
  }
  if (p.scope?.length) {
    const keys = p.scope.map((s, i) => {
      params[`scope${i}`] = s;
      return `@scope${i}`;
    });
    where.push(`e.scope IN (${keys.join(', ')})`);
  }
  return { where, params };
}

export function searchEvents(db: Db, p: EventSearchParams): EventHit[] {
  const { where, params } = buildEventFilters(p);
  params.limit = p.limit;

  if (p.mode === 'keyword') {
    const match = toFtsQuery(p.query ?? '');
    if (!match) return [];
    params.match = match;
    const sql = `
      SELECT e.*, snippet(events_fts, 0, '[', ']', '…', 12) AS snippet
      FROM events_fts JOIN events e ON e.seq = events_fts.rowid
      WHERE events_fts MATCH @match ${where.map((w) => `AND ${w}`).join(' ')}
      ORDER BY bm25(events_fts), e.ts DESC
      LIMIT @limit`;
    return (db.prepare(sql).all(params) as HitRow[]).map((row) => toHit(row));
  }

  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql =
    p.since || p.until
      ? `SELECT e.*, NULL AS snippet FROM events e ${filter} ORDER BY e.ts ASC, e.seq ASC LIMIT @limit`
      : `SELECT * FROM (
           SELECT e.*, NULL AS snippet FROM events e ${filter} ORDER BY e.ts DESC, e.seq DESC LIMIT @limit
         ) ORDER BY ts ASC, seq ASC`;
  return (db.prepare(sql).all(params) as HitRow[]).map((row) => toHit(row));
}

/**
 * §7 composite-scored keyword search: fetches a candidate pool (max(limit*5, 50)) by bm25, scores
 * each with `rankHits` (bm25_norm + recency + activation + importance + pin, minus penalties), then
 * cuts to `p.limit`. Events have no access rows (only claims are logged, per §7/D-note), so
 * activation is always 0 and events are never pinned (pins apply to claims, §6.9).
 *
 * J5: `snippet()` is computed in a second, narrow query over just the final winning ids, not for the
 * whole candidate pool -- the pool can be up to `poolLimit` (up to 250 for the default limit=50) rows,
 * of which only `p.limit` ever survive ranking, so snippet-ing the rest was wasted work. `snippet()`
 * still needs to run inside a query carrying the same `events_fts MATCH` constraint (it reads the FTS
 * cursor's match state), so this can't just be a plain `events` lookup by id.
 */
export function searchEventsRanked(db: Db, p: EventSearchParams, now: string): EventHit[] {
  const match = toFtsQuery(p.query ?? '');
  if (!match) return [];

  const { where, params } = buildEventFilters(p);
  params.match = match;
  const limit = poolLimit(p.limit);

  const sqlBase = `
    SELECT e.*, bm25(events_fts) AS rank
    FROM events_fts JOIN events e ON e.seq = events_fts.rowid
    WHERE events_fts MATCH @match ${where.map((w) => `AND ${w}`).join(' ')}
    ORDER BY bm25(events_fts), e.ts DESC`;

  const gate = p.gate ?? 'none';
  const ftsRows = fetchCandidates<RawEventRow & { rank: number }>({
    db,
    ftsTable: 'events_fts',
    sqlBase,
    params,
    gate,
    query: p.query ?? '',
    limit,
  });

  let rows: (RawEventRow & { rank: number | null })[];
  const cosineById = new Map<string, number>();

  if (p.queryVector === undefined) {
    rows = ftsRows;
  } else {
    // Phase 6 (D42/hybrid): candidates = FTS pool UNION top-K by cosine, each admitted only if
    // cosine >= tau OR it passes gate A (always gate A, independent of `gate` above). Admission is
    // applied to raw cosine BEFORE the scorable set is built, never to the composite score.
    const tau = p.tau ?? DEFAULT_TAU;
    for (const [id, cos] of cosineScoresFiltered(db, 'event', where, params, p.queryVector, p.queryModel)) cosineById.set(id, cos);
    const topK = topKFromScores(cosineById, limit);

    const ftsIds = new Set(ftsRows.map((r) => r.id));
    const vectorOnlyIds = [...topK.keys()].filter((id) => !ftsIds.has(id));
    const vectorOnlyRows =
      vectorOnlyIds.length === 0
        ? []
        : (db
            .prepare(`SELECT e.* FROM events e WHERE e.id IN (${vectorOnlyIds.map(() => '?').join(', ')})`)
            .all(...vectorOnlyIds) as RawEventRow[]).map((r) => ({ ...r, rank: null as number | null }));

    const union = [...ftsRows.map((r) => ({ ...r, rank: r.rank as number | null })), ...vectorOnlyRows];
    const passedGateA = gateAPassed(db, 'events_fts', union.map((r) => r.seq), p.query ?? '');
    rows = union.filter((r) => {
      const cos = cosineById.get(r.id);
      return (cos !== undefined && cos >= tau) || passedGateA.has(r.seq);
    });
  }
  if (rows.length === 0) return [];

  const scorable = rows.map((row) => {
    const e = rowToEvent(row);
    const cosine = cosineById.get(e.id);
    return {
      id: e.id,
      rank: row.rank,
      cosine,
      ts: e.ts,
      accessTs: [] as string[],
      importance: e.kind === 'explicit_remember' ? 0.8 : 0.5,
      pinned: false,
      flags: e.flags,
      scope: e.scope,
      row,
    };
  });

  const ranked = rankHits(scorable, { now, requestedScopes: p.scope }).slice(0, p.limit);
  if (ranked.length === 0) return [];

  const finalIds = ranked.map((r) => r.row.id);
  const placeholders = finalIds.map(() => '?').join(', ');
  const snippetById = new Map(
    (
      db
        .prepare(
          `SELECT e.id AS id, snippet(events_fts, 0, '[', ']', '…', 12) AS snippet
           FROM events_fts JOIN events e ON e.seq = events_fts.rowid
           WHERE events_fts MATCH ? AND e.id IN (${placeholders})`,
        )
        .all(match, ...finalIds) as { id: string; snippet: string | null }[]
    ).map((r): [string, string | null] => [r.id, r.snippet]),
  );

  return ranked.map((r) => toHit({ ...r.row, snippet: snippetById.get(r.row.id) ?? null }, r.score, r.cosine ?? null));
}
