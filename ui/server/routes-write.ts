import { HttpError, type Ctx, type Route } from './context.js';
import { explain, forget, getClaims, getEvents, isPaused, pin, pinnedIds, setPaused, sourceCounts, unpin, writeExport, type ClaimRow, type Db, type ForgetPlan } from './core.js';
import { digest } from './digest.js';
import { memoryLine, messageLine } from './shape.js';
import type { ExportDone, ForgetDone, ForgetPreview, MemoryLine, MessageLine, PauseState, PinDone } from './types.js';

const PAUSED = (what: string): HttpError => new HttpError(409, 'paused', `engram is paused; ${what} is disabled until you resume`);

function idOf(m: RegExpMatchArray): string {
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    throw new HttpError(400, 'bad_request', 'bad id');
  }
}

function pinOrUnpin(ctx: Ctx, m: RegExpMatchArray, wantPinned: boolean): PinDone {
  if (isPaused()) throw PAUSED(wantPinned ? 'pinning' : 'unpinning');
  const id = idOf(m);
  const e = explain(ctx.db, id);
  if (!e) throw new HttpError(404, 'not_found', 'no claim or event with that id');
  if (e.kind !== 'claim') throw new HttpError(400, 'bad_request', 'only memories can be pinned');
  const r = wantPinned ? pin(ctx.db, id) : unpin(ctx.db, id);
  return { id: r.id, pinned: r.pinned };
}

function memoryLines(db: Db, claims: ClaimRow[]): MemoryLine[] {
  const ids = claims.map((c) => c.id);
  const pinned = pinnedIds(db, ids);
  const counts = sourceCounts(db, ids);
  return claims.map((c) => memoryLine(c, { pinned: pinned.has(c.id), sources: counts.get(c.id) ?? 0 }));
}

const messageLines = (db: Db, ids: string[]): MessageLine[] => getEvents(db, ids).map((e) => messageLine(e));

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The plan as people-readable lines. Called after the core's preview, which rolled back, so every row still exists. */
function previewOf(db: Db, plan: ForgetPlan): ForgetPreview {
  const kind = plan.target.kind === 'claim' ? 'memory' : 'message';
  const notes: string[] = [];
  if (kind === 'memory') notes.push('The messages this memory was built from stay. Forget them too if the text itself must go.');
  else {
    if (plan.same_content_events.length > 0) notes.push(`The same text also exists in ${plural(plan.same_content_events.length, 'other captured message', 'other captured messages')}.`);
    if (plan.surviving_claims.length > 0) {
      const n = plan.surviving_claims.length;
      notes.push(`${plural(n, 'memory', 'memories')} built from this also ${n === 1 ? 'cites' : 'cite'} other messages and will stay.`);
    }
  }
  return {
    digest: digest(plan),
    kind,
    erases: { memories: memoryLines(db, getClaims(db, plan.claims)), messages: messageLines(db, plan.events) },
    stays: { memories: memoryLines(db, getClaims(db, plan.surviving_claims)), messages: messageLines(db, [...plan.same_content_events, ...plan.source_events]) },
    notes,
  };
}

function forgetRoute(ctx: Ctx, m: RegExpMatchArray): ForgetPreview | ForgetDone {
  const id = idOf(m);
  const body = ctx.body as { confirm?: unknown; digest?: unknown };
  if (typeof body.confirm !== 'boolean') throw new HttpError(400, 'bad_request', 'confirm must be true or false');
  if (!body.confirm) {
    // confirm:false runs the real deletes inside a transaction and rolls it back.
    return previewOf(ctx.db, forget(ctx.db, id, { confirm: false }).plan);
  }
  if (isPaused()) throw PAUSED('forgetting');
  if (typeof body.digest !== 'string' || body.digest === '') throw new HttpError(400, 'bad_request', 'confirming needs the digest from the preview');
  const plan = forget(ctx.db, id, { confirm: false }).plan;
  if (digest(plan) !== body.digest) throw new HttpError(409, 'changed', 'this changed since you looked; review it again');
  const done = forget(ctx.db, id, { confirm: true });
  return { forgotten: true, erased: { memories: done.deleted.claims, messages: done.deleted.events } };
}

export function writeRoutes(): Route[] {
  return [
    { method: 'POST', match: /^\/api\/memories\/([^/]+)\/pin$/, handle: (ctx, m): PinDone => pinOrUnpin(ctx, m, true) },
    { method: 'POST', match: /^\/api\/memories\/([^/]+)\/unpin$/, handle: (ctx, m): PinDone => pinOrUnpin(ctx, m, false) },
    { method: 'POST', match: /^\/api\/memories\/([^/]+)\/forget$/, handle: forgetRoute },
    { method: 'POST', match: /^\/api\/pause$/, handle: (): PauseState => (setPaused(true), { paused: true }) },
    { method: 'POST', match: /^\/api\/resume$/, handle: (): PauseState => (setPaused(false), { paused: false }) },
    // Never takes a path from the client: the core picks the file inside the data directory.
    { method: 'POST', match: /^\/api\/export$/, handle: ({ db }): ExportDone => ({ path: writeExport(db) }) },
  ];
}
