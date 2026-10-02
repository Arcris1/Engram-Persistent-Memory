import { HttpError, type Route } from './context.js';
import {
  activityByDay,
  claimMeta,
  explain,
  getStats,
  isPaused,
  listClaims,
  listEvents,
  listProjects,
  pinnedIds,
  searchClaimsRanked,
  searchEventsRanked,
  selectProfile,
  sourceCounts,
  stripControlChars,
  VERSION,
  type ClaimRow,
  type Db,
} from './core.js';
import { memoryLine, messageLine, messageLineFromHit, semanticStatus } from './shape.js';
import type { Detail, MemoriesPage, MemoryLine, MessageLine, Overview } from './types.js';

const PAGE = 50;
const PROFILE_LINES = 12;
const ACTIVITY_DAYS = 14;
const MAX_QUERY_CHARS = 500;

/** Lines for claims that carry no listing cursor of their own (profile, search hits, detail neighbours). */
function linesFor(db: Db, claims: { claim: ClaimRow; seq?: number | null }[], sources?: Map<string, number>): MemoryLine[] {
  const ids = claims.map((c) => c.claim.id);
  const pinned = pinnedIds(db, ids);
  const counts = sources ?? sourceCounts(db, ids);
  return claims.map(({ claim, seq }) => memoryLine(claim, { pinned: pinned.has(claim.id), sources: counts.get(claim.id) ?? 0, seq }));
}

/** Project filter: `noProject=1` = no project (null); else `project=<name>` = exact name (any text, "-" included); absent = all (undefined). */
function projectParam(url: URL): string | null | undefined {
  if (url.searchParams.get('noProject') === '1') return null;
  const p = url.searchParams.get('project');
  return p === null || p === '' ? undefined : p;
}

const flag = (url: URL, name: string): boolean => url.searchParams.get(name) === '1';

function overview({ db, dbFile, now, url }: Parameters<Route['handle']>[0]): Overview {
  // Same encoding as /api/memories; absent or noProject=1 both give the global-only profile.
  const project = projectParam(url) ?? null;
  const profile = selectProfile(db, { project, maxItems: PROFILE_LINES });
  return {
    version: VERSION,
    paused: isPaused(),
    project,
    stats: getStats(db, dbFile),
    profile: linesFor(db, profile.map((claim) => ({ claim }))),
    activity: activityByDay(db, ACTIVITY_DAYS, now()),
    semantic: semanticStatus(db),
  };
}

function memories({ db, now, url }: Parameters<Route['handle']>[0]): MemoriesPage {
  const kind = url.searchParams.get('kind') ?? 'memories';
  if (kind !== 'memories' && kind !== 'messages') throw new HttpError(400, 'bad_request', 'kind must be memories or messages');
  const beforeRaw = url.searchParams.get('before');
  if (beforeRaw !== null && !/^\d{1,15}$/.test(beforeRaw)) throw new HttpError(400, 'bad_request', 'before must be a number');
  const beforeSeq = beforeRaw === null ? undefined : Number(beforeRaw);
  const project = projectParam(url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS);
  const pinnedOnly = flag(url, 'pinned');
  const includeSuperseded = flag(url, 'replaced');
  const flaggedOnly = flag(url, 'flagged');
  const nextOf = (seqs: number[]): number | null => (seqs.length > PAGE ? seqs[PAGE - 1]! : null);

  if (q === '') {
    if (kind === 'memories') {
      const rows = listClaims(db, { project, includeSuperseded, pinnedOnly, limit: PAGE + 1, beforeSeq });
      const page = rows.slice(0, PAGE);
      return { kind, searched: false, items: linesFor(db, page.map((r) => ({ claim: r.claim, seq: r.seq }))), next: nextOf(rows.map((r) => r.seq)) };
    }
    const rows = listEvents(db, { project, flaggedOnly, limit: PAGE + 1, beforeSeq });
    const items: MessageLine[] = rows.slice(0, PAGE).map((r) => messageLine(r.event, { seq: r.seq }));
    return { kind, searched: false, items, next: nextOf(rows.map((r) => r.seq)) };
  }

  // Keyword search over everything, then the exact-project and toggle filters. Searching never logs accesses.
  const at = now().toISOString();
  if (kind === 'memories') {
    const hits = searchClaimsRanked(db, { query: q, mode: 'keyword', include_superseded: includeSuperseded, limit: PAGE }, at);
    const meta = claimMeta(db, hits.map((h) => h.id));
    const claims = hits.map((h) => ({
      claim: {
        id: h.id, subject: h.subject, predicate: h.predicate, object: h.object, statement: h.statement, scope: h.scope, confidence: h.confidence,
        valid_from: h.valid_from, valid_to: h.valid_to, recorded_at: h.recorded_at, superseded_by: null, status: h.status, importance: 0,
        access_count: meta.get(h.id)?.accessCount ?? 0, last_accessed: null, project: h.project, flags: meta.get(h.id)?.flags ?? h.flags,
      } satisfies ClaimRow,
    }));
    const lines = linesFor(db, claims).filter((l) => (project === undefined || l.project === project) && (!pinnedOnly || l.pinned));
    return { kind, searched: true, items: lines, next: null };
  }
  const hits = searchEventsRanked(db, { query: q, mode: 'keyword', limit: PAGE }, at);
  const items = hits
    .filter((h) => (project === undefined || h.project === project) && (!flaggedOnly || h.flags.length > 0))
    .map(messageLineFromHit);
  return { kind, searched: true, items, next: null };
}

function detail({ db }: Parameters<Route['handle']>[0], m: RegExpMatchArray): Detail {
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    throw new HttpError(400, 'bad_request', 'bad id');
  }
  const e = explain(db, id);
  if (!e) throw new HttpError(404, 'not_found', 'no claim or event with that id');

  if (e.kind === 'claim') {
    const related = [e.item, ...e.supersedes, ...(e.superseded_by ? [e.superseded_by] : [])];
    const ids = related.map((c) => c.id);
    const pinned = pinnedIds(db, ids);
    const counts = sourceCounts(db, ids);
    const line = (c: ClaimRow): MemoryLine => memoryLine(c, { pinned: pinned.has(c.id), sources: counts.get(c.id) ?? 0 });
    return {
      kind: 'memory',
      memory: { ...line(e.item), confidence: e.item.confidence, scope: e.item.scope, recordedAt: e.item.recorded_at },
      sources: e.sources.map((s) => ({ message: messageLine(s.event), excerpt: s.excerpt === null ? null : stripControlChars(s.excerpt) })),
      replaces: e.supersedes.map(line),
      replacedBy: e.superseded_by ? line(e.superseded_by) : null,
    };
  }
  const pinned = pinnedIds(db, e.derived_claims.map((d) => d.claim.id));
  return {
    kind: 'message',
    message: messageLine(e.item, { full: true }),
    built: e.derived_claims.map((d) => memoryLine(d.claim, { pinned: pinned.has(d.claim.id), sources: d.source_ids.length })),
  };
}

export function readRoutes(): Route[] {
  return [
    { method: 'GET', match: /^\/api\/overview$/, handle: (ctx) => overview(ctx) },
    { method: 'GET', match: /^\/api\/projects$/, handle: ({ db }) => ({ projects: listProjects(db) }) },
    { method: 'GET', match: /^\/api\/memories$/, handle: (ctx) => memories(ctx) },
    { method: 'GET', match: /^\/api\/memories\/([^/]+)$/, handle: detail },
  ];
}
