import { describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { activityByDay, claimMeta, countEmbeddings, getClaims, getEvents, listClaims, listEvents, listProjects, pinnedIds, sourceCounts } from '../src/control/list.js';
import { pin } from '../src/control/marks.js';
import { appendEvent } from '../src/events/events.js';
import { openDb, type Db } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

function freshDb(): Db {
  return openDb(tmpDbFile());
}

let n = 0;
function addClaim(db: Db, o: { project?: string | null; now?: string; sources?: string[] } = {}): string {
  n += 1;
  const sources = o.sources ?? [addEvent(db)];
  const r = upsertClaims(db, {
    now: o.now,
    claims: [
      {
        subject: `subj-${n}`,
        predicate: 'uses',
        object: `obj-${n}`,
        statement: `statement number ${n}`,
        scope: 'fact',
        confidence: 0.9,
        project: o.project ?? null,
        sources: sources.map((event_id) => ({ event_id, excerpt: 'event content' })),
      },
    ],
  });
  if (r.rejected.length > 0) throw new Error(r.rejected[0]!.reason);
  return r.inserted[0]!;
}

function addEvent(db: Db, o: { ts?: string; project?: string | null; flags?: string[]; content?: string } = {}): string {
  n += 1;
  return appendEvent(db, {
    sessionId: `s-${n}`,
    role: 'user',
    content: o.content ?? `event content ${n}`,
    sourceRef: `ref-${n}`,
    ts: o.ts,
    project: o.project ?? null,
    preProcessedFlags: o.flags,
  }).id;
}

describe('listClaims', () => {
  it('orders newest first (recorded_at DESC, seq DESC) and honours limit', () => {
    const db = freshDb();
    const a = addClaim(db, { now: '2026-01-01T00:00:00.000Z' });
    const b = addClaim(db, { now: '2026-03-01T00:00:00.000Z' });
    const c = addClaim(db, { now: '2026-03-01T00:00:00.000Z' });
    expect(listClaims(db, { limit: 10 }).map((r) => r.claim.id)).toEqual([c, b, a]);
    expect(listClaims(db, { limit: 2 }).map((r) => r.claim.id)).toEqual([c, b]);
    db.close();
  });

  it('beforeSeq pages with no overlap, even when recorded_at is not monotonic in seq', () => {
    const db = freshDb();
    const ids = [
      addClaim(db, { now: '2026-05-01T00:00:00.000Z' }),
      addClaim(db, { now: '2026-01-01T00:00:00.000Z' }),
      addClaim(db, { now: '2026-04-01T00:00:00.000Z' }),
      addClaim(db, { now: '2026-02-01T00:00:00.000Z' }),
      addClaim(db, { now: '2026-03-01T00:00:00.000Z' }),
    ];
    const all = listClaims(db, { limit: 10 });
    const seen: string[] = [];
    let before: number | undefined;
    for (;;) {
      const page = listClaims(db, { limit: 2, beforeSeq: before });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.claim.id));
      before = page[page.length - 1]!.seq;
    }
    expect(seen).toEqual(all.map((r) => r.claim.id));
    expect(new Set(seen).size).toBe(ids.length);
    db.close();
  });

  it('project: undefined = all, null = no project, string = exact', () => {
    const db = freshDb();
    const a = addClaim(db, { project: 'alpha' });
    const b = addClaim(db, { project: 'beta' });
    const c = addClaim(db, { project: null });
    expect(listClaims(db, { limit: 10 }).map((r) => r.claim.id).sort()).toEqual([a, b, c].sort());
    expect(listClaims(db, { limit: 10, project: null }).map((r) => r.claim.id)).toEqual([c]);
    expect(listClaims(db, { limit: 10, project: 'alpha' }).map((r) => r.claim.id)).toEqual([a]);
    db.close();
  });

  it('includeSuperseded and pinnedOnly', () => {
    const db = freshDb();
    const a = addClaim(db);
    const b = addClaim(db);
    pin(db, a);
    db.prepare(`UPDATE claims SET status = 'superseded' WHERE id = ?`).run(b);
    expect(listClaims(db, { limit: 10 }).map((r) => r.claim.id)).toEqual([a]);
    expect(listClaims(db, { limit: 10, includeSuperseded: true })).toHaveLength(2);
    expect(listClaims(db, { limit: 10, pinnedOnly: true }).map((r) => r.claim.id)).toEqual([a]);
    expect(listClaims(db, { limit: 10, pinnedOnly: true, project: 'nope' })).toEqual([]);
    db.close();
  });
});

describe('paging across equal timestamps', () => {
  it('claims: identical recorded_at over a page boundary -> no skip, no duplicate', () => {
    const db = freshDb();
    const ids = Array.from({ length: 7 }, () => addClaim(db, { now: '2026-03-01T00:00:00.000Z' }));
    const seen: string[] = [];
    let before: number | undefined;
    for (;;) {
      const page = listClaims(db, { limit: 3, beforeSeq: before });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.claim.id));
      before = page[page.length - 1]!.seq;
    }
    expect(seen).toEqual([...ids].reverse());
    db.close();
  });

  it('events: identical ts over a page boundary -> no skip, no duplicate', () => {
    const db = freshDb();
    const ids = Array.from({ length: 7 }, () => addEvent(db, { ts: '2026-01-05T00:00:00.000Z' }));
    const seen: string[] = [];
    let before: number | undefined;
    for (;;) {
      const page = listEvents(db, { limit: 3, beforeSeq: before });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.event.id));
      before = page[page.length - 1]!.seq;
    }
    expect(seen).toEqual([...ids].reverse());
    db.close();
  });
});

describe('listEvents', () => {
  it('orders by ts DESC, seq DESC; beforeSeq pages without overlap; limit', () => {
    const db = freshDb();
    const ids = [
      addEvent(db, { ts: '2026-01-03T00:00:00.000Z' }),
      addEvent(db, { ts: '2026-01-01T00:00:00.000Z' }),
      addEvent(db, { ts: '2026-01-05T00:00:00.000Z' }),
      addEvent(db, { ts: '2026-01-05T00:00:00.000Z' }),
      addEvent(db, { ts: '2026-01-02T00:00:00.000Z' }),
    ];
    const all = listEvents(db, { limit: 10 }).map((r) => r.event.id);
    expect(all).toEqual([ids[3], ids[2], ids[0], ids[4], ids[1]]);
    expect(listEvents(db, { limit: 2 })).toHaveLength(2);
    const seen: string[] = [];
    let before: number | undefined;
    for (;;) {
      const page = listEvents(db, { limit: 2, beforeSeq: before });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.event.id));
      before = page[page.length - 1]!.seq;
    }
    expect(seen).toEqual(all);
    db.close();
  });

  it('project semantics and flaggedOnly', () => {
    const db = freshDb();
    const a = addEvent(db, { project: 'alpha', flags: ['truncated'] });
    const b = addEvent(db, { project: null });
    const c = addEvent(db, { project: 'beta' });
    expect(listEvents(db, { limit: 10 })).toHaveLength(3);
    expect(listEvents(db, { limit: 10, project: null }).map((r) => r.event.id)).toEqual([b]);
    expect(listEvents(db, { limit: 10, project: 'beta' }).map((r) => r.event.id)).toEqual([c]);
    expect(listEvents(db, { limit: 10, flaggedOnly: true }).map((r) => r.event.id)).toEqual([a]);
    db.close();
  });
});

describe('listProjects, pinnedIds, sourceCounts, countEmbeddings', () => {
  it('listProjects is the sorted distinct non-null union of claims and events', () => {
    const db = freshDb();
    addClaim(db, { project: 'zeta' });
    addClaim(db, { project: 'alpha' });
    addEvent(db, { project: 'alpha' });
    addEvent(db, { project: 'mid' });
    addEvent(db, { project: null });
    expect(listProjects(db)).toEqual(['alpha', 'mid', 'zeta']);
    db.close();
  });

  it('pinnedIds chunks 1,200 ids', () => {
    const db = freshDb();
    const real = [addClaim(db), addClaim(db), addClaim(db)];
    pin(db, real[0]!);
    pin(db, real[2]!);
    const ids = [...Array.from({ length: 600 }, (_, i) => `x-${i}`), real[0]!, real[1]!, ...Array.from({ length: 597 }, (_, i) => `y-${i}`), real[2]!];
    expect(ids).toHaveLength(1200);
    expect(pinnedIds(db, ids)).toEqual(new Set([real[0], real[2]]));
    expect(pinnedIds(db, [])).toEqual(new Set());
    db.close();
  });

  it('sourceCounts counts cited events, 0 for none', () => {
    const db = freshDb();
    const e1 = addEvent(db);
    const e2 = addEvent(db);
    const a = addClaim(db, { sources: [e1, e2] });
    const b = addClaim(db, { sources: [e1] });
    expect(sourceCounts(db, [a, b, 'unknown'])).toEqual(new Map([[a, 2], [b, 1], ['unknown', 0]]));
    db.close();
  });

  it('countEmbeddings counts rows', () => {
    const db = freshDb();
    expect(countEmbeddings(db)).toBe(0);
    db.prepare(`INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at) VALUES ('claim','c1','m','h',1,x'00','2026-01-01')`).run();
    expect(countEmbeddings(db)).toBe(1);
    db.close();
  });
});

describe('getClaims, getEvents', () => {
  it('resolve ids in chunks and skip unknown ones', () => {
    const db = freshDb();
    const a = addClaim(db);
    const b = addClaim(db);
    const e1 = addEvent(db);
    const ids = [...Array.from({ length: 700 }, (_, i) => `x-${i}`), b, a];
    expect(getClaims(db, ids).map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(getClaims(db, []).length).toBe(0);
    expect(getEvents(db, [...ids, e1]).map((e) => e.id)).toContain(e1);
    expect(getEvents(db, ['nope'])).toEqual([]);
    db.close();
  });
});

describe('claimMeta', () => {
  it('returns access count, flags per existing id, chunked', () => {
    const db = freshDb();
    const a = addClaim(db);
    const b = addClaim(db);
    db.prepare(`UPDATE claims SET access_count = 7, flags = '["imported"]' WHERE id = ?`).run(b);
    const ids = [...Array.from({ length: 700 }, (_, i) => `x-${i}`), a, b];
    const m = claimMeta(db, ids);
    expect(m.size).toBe(2);
    expect(m.get(a)).toMatchObject({ accessCount: 0, flags: [] });
    expect(m.get(b)).toMatchObject({ accessCount: 7, flags: ['imported'] });
    expect(m.get(a)).toEqual({ accessCount: 0, flags: [] });
    expect(claimMeta(db, []).size).toBe(0);
    db.close();
  });
});

describe('activityByDay', () => {
  it('returns exactly N local days, oldest first, zero-filled, counts matching inserts', () => {
    const db = freshDb();
    const now = new Date(2026, 5, 15, 12, 0, 0); // local noon
    const at = (daysAgo: number, h: number): string => new Date(2026, 5, 15 - daysAgo, h, 30, 0).toISOString();
    addEvent(db, { ts: at(0, 9) });
    addEvent(db, { ts: at(0, 23) });
    addEvent(db, { ts: at(2, 0) }); // just after local midnight
    addEvent(db, { ts: at(6, 12) });
    addEvent(db, { ts: at(9, 12) }); // outside a 7-day window
    const out = activityByDay(db, 7, now);
    expect(out).toHaveLength(7);
    expect(out.map((d) => d.day)).toEqual(['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15']);
    expect(out.map((d) => d.count)).toEqual([1, 0, 0, 0, 1, 0, 2]);
    db.close();
  });
});
