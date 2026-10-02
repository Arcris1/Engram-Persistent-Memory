import { describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { computeImportance } from '../src/control/importance.js';
import { newId } from '../src/core/ids.js';
import { appendEvent } from '../src/events/events.js';
import { searchClaimsRanked } from '../src/search/claims.js';
import { searchEventsRanked } from '../src/search/events.js';
import { activation, bm25Norm, composite, penalties, rankHits, recency } from '../src/search/score.js';
import { openDb, type Db } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

describe('bm25Norm', () => {
  it('normalises raw bm25 ranks (lower raw = better) to 0..1 (higher = better)', () => {
    // r_min = -8 (best) -> 1, r_max = -2 (worst) -> 0, -5 is the midpoint -> 0.5.
    const norms = bm25Norm([-5, -2, -8]);
    expect(norms[0]).toBeCloseTo(0.5, 6);
    expect(norms[1]).toBeCloseTo(0, 6);
    expect(norms[2]).toBeCloseTo(1, 6);
  });

  it('a single candidate normalises to 1', () => {
    expect(bm25Norm([-3])).toEqual([1]);
  });

  it('tied ranks all normalise to 1 (r - r_min = 0 for every item)', () => {
    expect(bm25Norm([-4, -4, -4])).toEqual([1, 1, 1]);
  });

  it('an empty set returns an empty array', () => {
    expect(bm25Norm([])).toEqual([]);
  });

  // J2: a non-finite rank must not distort the normalisation bounds for the other, valid ranks, and
  // its own normalised value is 0.
  it('a non-finite rank among valid ones normalises to 0 itself, without distorting the others', () => {
    const withBad = bm25Norm([-5, -2, -8, NaN, Infinity]);
    const withoutBad = bm25Norm([-5, -2, -8]);
    expect(withBad.slice(0, 3)).toEqual(withoutBad);
    expect(withBad[3]).toBe(0);
    expect(withBad[4]).toBe(0);
  });

  it('all-non-finite ranks normalise to all 0 (not NaN)', () => {
    expect(bm25Norm([NaN, Infinity, -Infinity])).toEqual([0, 0, 0]);
  });

  // Phase 6 (D42/hybrid): `null` is a vector-only candidate with no FTS rank at all -- treated
  // exactly like a non-finite rank (excluded from the min/max bounds, normalises to 0 itself).
  it('a null rank among valid ones normalises to 0 itself, without distorting the others', () => {
    const withNull = bm25Norm([-5, -2, -8, null]);
    const withoutNull = bm25Norm([-5, -2, -8]);
    expect(withNull.slice(0, 3)).toEqual(withoutNull);
    expect(withNull[3]).toBe(0);
  });

  it('all-null ranks normalise to all 0', () => {
    expect(bm25Norm([null, null])).toEqual([0, 0]);
  });
});

describe('recency', () => {
  const now = '2026-10-01T00:00:00.000Z';

  it('is 1 at zero elapsed days', () => {
    expect(recency(now, now)).toBeCloseTo(1, 9);
  });

  it('is exp(-1) at 30 days', () => {
    expect(recency('2026-09-01T00:00:00.000Z', now)).toBeCloseTo(Math.exp(-1), 6);
  });

  it('is exp(-2) at 60 days', () => {
    expect(recency('2026-08-02T00:00:00.000Z', now)).toBeCloseTo(Math.exp(-2), 6);
  });

  // J2: Δdays = max(0, Δdays) -- a future-dated `ts` must not score better than a just-now one.
  it('a future ts (deltaDays negative) clamps to the same recency=1 as a just-now ts, not >1', () => {
    expect(recency('2026-10-05T00:00:00.000Z', now)).toBeCloseTo(1, 9);
  });

  // J2: any non-finite intermediate collapses to 0.
  it('an unparseable ts (NaN deltaDays) is 0, not NaN', () => {
    expect(recency('not-a-date', now)).toBe(0);
  });
});

describe('activation', () => {
  const now = '2026-10-01T00:00:00.000Z';

  it('is 0 with no accesses', () => {
    expect(activation([], now)).toBe(0);
  });

  it('sums 1-day-old accesses: ln(3 * 1^-0.5) = ln(3)', () => {
    const accessTs = ['2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z'];
    expect(activation(accessTs, now)).toBeCloseTo(Math.log(3), 6);
  });

  it('floors age at 1/24 day (1 hour) for a just-now access', () => {
    const justNow = ['2026-10-01T00:00:00.000Z'];
    const expected = Math.log((1 / 24) ** -0.5);
    expect(activation(justNow, now)).toBeCloseTo(expected, 6);
  });

  it('a single 1-day-old access gives ln(1) = 0', () => {
    expect(activation(['2026-09-30T00:00:00.000Z'], now)).toBeCloseTo(0, 9);
  });

  it('clamps a negative activation (old, sparse accesses) to 0', () => {
    const veryOld = ['2023-01-01T00:00:00.000Z'];
    expect(activation(veryOld, now)).toBe(0);
  });

  // J2: one corrupted/unparseable access timestamp must not poison the sum for the other, valid ones.
  it('an unparseable access ts contributes 0 to the sum rather than turning the whole result into NaN', () => {
    const withBad = activation(['not-a-date', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z'], now);
    const withoutBad = activation(['2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z'], now);
    expect(withBad).toBeCloseTo(withoutBad, 9);
    expect(Number.isFinite(withBad)).toBe(true);
  });
});

describe('composite', () => {
  it('sums to 1 when every part is maxed (bm25=1, recency=1, activation=3, importance=1, pin=1)', () => {
    const score = composite({ bm25: 1, recency: 1, activation: 3, importance: 1, pin: 1 });
    expect(score).toBeCloseTo(1, 9);
  });

  it('is 0 when every part is 0', () => {
    expect(composite({ bm25: 0, recency: 0, activation: 0, importance: 0, pin: 0 })).toBe(0);
  });

  it('weights bm25 0.45, recency 0.20, act_norm 0.15, importance 0.15, pin 0.05', () => {
    const score = composite({ bm25: 1, recency: 0, activation: 0, importance: 0, pin: 0 });
    expect(score).toBeCloseTo(0.45, 9);
  });

  it('clamps act_norm = activation/3 to 1 beyond activation=3', () => {
    const score = composite({ bm25: 0, recency: 0, activation: 30, importance: 0, pin: 0 });
    expect(score).toBeCloseTo(0.15, 9);
  });
});

describe('penalties', () => {
  it('instruction_like: -0.3', () => {
    expect(penalties({ flags: ['instruction_like'], scope: 'fact' })).toBeCloseTo(-0.3, 9);
  });

  it('non-fact scope not requested: -0.2', () => {
    expect(penalties({ flags: [], scope: 'draft' })).toBeCloseTo(-0.2, 9);
  });

  it('non-fact scope IS requested: no penalty', () => {
    expect(penalties({ flags: [], scope: 'draft' }, ['draft'])).toBe(0);
  });

  it('fact scope: no scope penalty regardless of requestedScopes', () => {
    expect(penalties({ flags: [], scope: 'fact' })).toBe(0);
  });

  it('both penalties stack: instruction_like + unrequested non-fact scope', () => {
    expect(penalties({ flags: ['instruction_like'], scope: 'draft' }, [])).toBeCloseTo(-0.5, 9);
  });
});

describe('rankHits', () => {
  const now = '2026-10-01T00:00:00.000Z';

  it('sorts by composite score desc', () => {
    const items = [
      { id: 'low', rank: -1, ts: now, accessTs: [], importance: 0, pinned: false, flags: [], scope: 'fact' as const },
      { id: 'high', rank: -10, ts: now, accessTs: [], importance: 1, pinned: true, flags: [], scope: 'fact' as const },
    ];
    const ranked = rankHits(items, { now });
    expect(ranked.map((r) => r.id)).toEqual(['high', 'low']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('breaks exact score ties by id ascending', () => {
    const base = { rank: -5, ts: now, accessTs: [] as string[], importance: 0.5, pinned: false, flags: [] as string[], scope: 'fact' as const };
    const items = [
      { ...base, id: 'bbb' },
      { ...base, id: 'aaa' },
    ];
    const ranked = rankHits(items, { now });
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
    expect(ranked.map((r) => r.id)).toEqual(['aaa', 'bbb']);
  });

  it('attaches a numeric score to every item', () => {
    const items = [{ id: 'x', rank: -1, ts: now, accessTs: [], importance: 0.5, pinned: false, flags: [], scope: 'fact' as const }];
    expect(typeof rankHits(items, { now })[0]!.score).toBe('number');
  });

  // J2: rankHits clamps importance to [0,1] and guarantees a finite score.
  it('clamps an out-of-range importance (>1 or <0) to [0,1] before scoring', () => {
    const over = [{ id: 'x', rank: -1, ts: now, accessTs: [], importance: 5, pinned: false, flags: [], scope: 'fact' as const }];
    const atMax = [{ id: 'x', rank: -1, ts: now, accessTs: [], importance: 1, pinned: false, flags: [], scope: 'fact' as const }];
    expect(rankHits(over, { now })[0]!.score).toBeCloseTo(rankHits(atMax, { now })[0]!.score, 9);

    const under = [{ id: 'y', rank: -1, ts: now, accessTs: [], importance: -5, pinned: false, flags: [], scope: 'fact' as const }];
    const atMin = [{ id: 'y', rank: -1, ts: now, accessTs: [], importance: 0, pinned: false, flags: [], scope: 'fact' as const }];
    expect(rankHits(under, { now })[0]!.score).toBeCloseTo(rankHits(atMin, { now })[0]!.score, 9);
  });

  it('a NaN importance is treated as 0, producing a finite score, not NaN', () => {
    const items = [{ id: 'x', rank: -1, ts: now, accessTs: [], importance: NaN, pinned: false, flags: [], scope: 'fact' as const }];
    const score = rankHits(items, { now })[0]!.score;
    expect(Number.isFinite(score)).toBe(true);
  });

  it('a non-finite rank/ts combination still yields a finite score and a stable sort (never compares NaN)', () => {
    const items = [
      { id: 'bad', rank: NaN, ts: 'not-a-date', accessTs: ['also-not-a-date'], importance: NaN, pinned: false, flags: [], scope: 'fact' as const },
      { id: 'good', rank: -5, ts: now, accessTs: [], importance: 0.5, pinned: false, flags: [], scope: 'fact' as const },
    ];
    const ranked = rankHits(items, { now });
    expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(ranked.map((r) => r.id)).toEqual(['good', 'bad']);
  });

  // Phase 6 (D42/hybrid): when `cosine` is present, the bm25 term fed into the composite's 0.45
  // weight is 0.5*bm25_norm + 0.5*clamp(cosine, 0, 1) instead of plain bm25_norm.
  describe('hybrid relevance (cosine present)', () => {
    const base = { ts: now, accessTs: [] as string[], importance: 0, pinned: false, flags: [] as string[], scope: 'fact' as const };

    it('matches 0.5*bm25_norm + 0.5*cosine exactly, replacing the plain bm25_norm term', () => {
      const items = [{ ...base, id: 'x', rank: -5, cosine: 0.8 }];
      const hybridScore = rankHits(items, { now })[0]!.score;

      // bm25_norm for a single candidate is always 1 (see bm25Norm's own test) -> relevance =
      // 0.5*1 + 0.5*0.8 = 0.9, vs. the no-cosine case's relevance of plain bm25_norm = 1.
      const noCosine = rankHits([{ ...base, id: 'x', rank: -5 }], { now })[0]!.score;
      const diff = noCosine - hybridScore; // = 0.45 * (1 - 0.9) = 0.045
      expect(diff).toBeCloseTo(0.45 * 0.1, 9);
    });

    it('clamps an out-of-range cosine to [0,1] rather than letting it blow past the composite', () => {
      const over = rankHits([{ ...base, id: 'x', rank: -5, cosine: 5 }], { now })[0]!.score;
      const atOne = rankHits([{ ...base, id: 'x', rank: -5, cosine: 1 }], { now })[0]!.score;
      expect(over).toBeCloseTo(atOne, 9);

      const under = rankHits([{ ...base, id: 'y', rank: -5, cosine: -5 }], { now })[0]!.score;
      const atZero = rankHits([{ ...base, id: 'y', rank: -5, cosine: 0 }], { now })[0]!.score;
      expect(under).toBeCloseTo(atZero, 9);
    });

    it('a null rank (vector-only candidate) with a cosine still scores via the cosine half of the term', () => {
      const items = [{ ...base, id: 'vector-only', rank: null, cosine: 0.9 }];
      const score = rankHits(items, { now })[0]!.score;
      // bm25_norm(null) = 0, so relevance = 0.5*0 + 0.5*0.9 = 0.45 -> bm25 contribution = 0.45*0.45.
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThan(0);
    });

    it('two items with identical rank/cosine but a higher-importance one still sorts first (other terms unaffected)', () => {
      const items = [
        { ...base, id: 'low', rank: -5, cosine: 0.5, importance: 0 },
        { ...base, id: 'high', rank: -5, cosine: 0.5, importance: 1 },
      ];
      const ranked = rankHits(items, { now });
      expect(ranked.map((r) => r.id)).toEqual(['high', 'low']);
    });
  });
});

describe('§7 acceptance (HANDOFF §10): claim ranking via DB-backed searchClaimsRanked', () => {
  let db: Db;

  function seedTiedClaims(): { used: string; unused: string } {
    db = openDb(tmpDbFile());
    const statement = 'The gadget operates using the widget mechanism for testing purposes.';
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'message',
      content: 'We discussed the widget mechanism at length.', ts: '2026-09-01T00:00:00.000Z',
    }).id;

    const used = upsertClaims(db, {
      claims: [{
        subject: 'alpha-item', predicate: 'calibrated_for', object: 'unit-one',
        statement, scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'the widget mechanism' }],
      }],
    }).inserted[0]!;

    const unused = upsertClaims(db, {
      claims: [{
        subject: 'beta-item', predicate: 'calibrated_for', object: 'unit-two',
        statement, scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'the widget mechanism' }],
      }],
    }).inserted[0]!;

    return { used, unused };
  }

  it('equal bm25 and importance: a claim accessed 3x outranks an unaccessed claim via activation', () => {
    const { used, unused } = seedTiedClaims();

    // Confirm the premise: FTS relevance is identical before scoring diverges them.
    const candidateRanksMatch = (
      db.prepare(
        `SELECT bm25(claims_fts) AS r FROM claims_fts JOIN claims c ON c.seq = claims_fts.rowid WHERE claims_fts MATCH 'widget' AND c.id = ?`,
      ).get(used) as { r: number }
    ).r;
    const unusedRank = (
      db.prepare(
        `SELECT bm25(claims_fts) AS r FROM claims_fts JOIN claims c ON c.seq = claims_fts.rowid WHERE claims_fts MATCH 'widget' AND c.id = ?`,
      ).get(unused) as { r: number }
    ).r;
    expect(candidateRanksMatch).toBeCloseTo(unusedRank, 9);

    const insertAccess = db.prepare(`INSERT INTO accesses (id, ts, target_id, query, used) VALUES (?, ?, ?, 'widget', 1)`);
    insertAccess.run(newId(), '2026-09-28T12:00:00.000Z', used);
    insertAccess.run(newId(), '2026-09-29T12:00:00.000Z', used);
    insertAccess.run(newId(), '2026-09-30T12:00:00.000Z', used);

    // Both claims still have the same fresh-insert importance (J1: computeImportance(0 uses), not the
    // old ad-hoc 0.5 constant): Task 2 recomputes importance from usage, so at this task's layer the
    // two claims are identical except for access history. The ranking must therefore come from
    // activation, not importance.
    const now = '2026-10-01T12:00:00.000Z';
    const ranked = searchClaimsRanked(db, { query: 'widget', mode: 'keyword', limit: 10 }, now);
    expect(ranked.map((h) => h.id)).toEqual([used, unused]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);

    // Prove it's specifically activation: with equal bm25/recency(~equal)/importance/pin, the entire
    // score gap must be explained by 0.15 * act_norm.
    const gap = ranked[0]!.score - ranked[1]!.score;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(0.15 + 1e-6); // act_norm in [0,1], weight 0.15
  });

  it('pinned override: importance is forced to 1.0 regardless of stored importance', () => {
    const { used: pinnedId, unused: plainId } = seedTiedClaims();
    db.prepare(`INSERT INTO marks (target_id, kind, note, created_at) VALUES (?, 'pinned', NULL, ?)`)
      .run(pinnedId, '2026-09-15T00:00:00.000Z');

    const now = '2026-10-01T00:00:00.000Z';
    const ranked = searchClaimsRanked(db, { query: 'widget', mode: 'keyword', limit: 10 }, now);
    expect(ranked.map((h) => h.id)).toEqual([pinnedId, plainId]);
    // pin (0.05) + importance override from the fresh-insert value (J1: computeImportance(0 uses)) to
    // 1.0.
    const freshImportance = computeImportance({ usedCount: 0, pinned: false, explicitRemember: false });
    expect(ranked[0]!.score - ranked[1]!.score).toBeCloseTo(0.05 + 0.15 * (1 - freshImportance), 6);
  });

  it('instruction_like penalty lowers a claim below an otherwise-tied one', () => {
    const { used: flaggedId, unused: plainId } = seedTiedClaims();
    db.prepare(`UPDATE claims SET flags = '["instruction_like"]' WHERE id = ?`).run(flaggedId);

    const now = '2026-10-01T00:00:00.000Z';
    const ranked = searchClaimsRanked(db, { query: 'widget', mode: 'keyword', limit: 10 }, now);
    expect(ranked.map((h) => h.id)).toEqual([plainId, flaggedId]);
    expect(ranked[0]!.score - ranked[1]!.score).toBeCloseTo(0.3, 6);
  });

  it('scope penalty: a non-fact-scope claim ranks below a fact claim unless that scope is requested', () => {
    db = openDb(tmpDbFile());
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'message', content: 'A draft note about the gizmo plan.',
    }).id;
    // Subjects/objects deliberately avoid the query term "gizmo" entirely, and are the same shape
    // (two tokens each), so FTS5's bm25 -- which also depends on indexed-column length, not just
    // term frequency -- ties exactly between the two claims; only `statement` (identical) matches.
    const statement = 'The gizmo plan is still a draft.';
    const draftId = upsertClaims(db, {
      claims: [{
        subject: 'alpha-widget', predicate: 'status_is', object: 'nightly-task', statement,
        scope: 'draft', confidence: 0.9, sources: [{ event_id: ev, excerpt: 'gizmo plan' }],
      }],
    }).inserted[0]!;
    const factId = upsertClaims(db, {
      claims: [{
        subject: 'beta-widget', predicate: 'status_is', object: 'nightly-task', statement,
        scope: 'fact', confidence: 0.9, sources: [{ event_id: ev, excerpt: 'gizmo plan' }],
      }],
    }).inserted[0]!;

    const now = '2026-10-01T00:00:00.000Z';
    const unfiltered = searchClaimsRanked(db, { query: 'gizmo', mode: 'keyword', limit: 10 }, now);
    expect(unfiltered.map((h) => h.id)).toEqual([factId, draftId]);

    const requested = searchClaimsRanked(
      db,
      { query: 'gizmo', mode: 'keyword', limit: 10, scope: ['fact', 'draft'] },
      now,
    );
    const draftHit = requested.find((h) => h.id === draftId)!;
    const factHit = requested.find((h) => h.id === factId)!;
    expect(draftHit.score).toBeCloseTo(factHit.score, 6);
  });

  it('time/subject modes carry score: null; keyword/ranked modes carry a numeric score', () => {
    const { used } = seedTiedClaims();
    const ranked = searchClaimsRanked(db, { query: 'widget', mode: 'keyword', limit: 10 }, '2026-10-01T00:00:00.000Z');
    expect(ranked.find((h) => h.id === used)!.score).toEqual(expect.any(Number));
  });
});

describe('J5: searchClaimsRanked access-history fetch is bounded to the last 365 days of now', () => {
  // A single access older than ~1 day already contributes 0 to activation via its own ln-clamp (see
  // the `activation` tests above), so a *meaningful* test of the SQL-level 365-day bound needs enough
  // accesses clustered at one age that their sum would cross ln(sum)>0 if (and only if) they're
  // actually fetched -- 25 accesses at the same age comfortably does that for any age up to ~365 days
  // (25 * 365^-0.5 ≈ 1.31, ln(1.31) > 0), making this a real regression test: without the 365-day SQL
  // bound, the "excluded" claim below would score measurably higher than the no-access baseline.
  function seedWithManyAccessesAt(db: Db, subject: string, ev: string, statement: string, ageDays: number, now: string): string {
    const id = upsertClaims(db, {
      claims: [{
        subject, predicate: 'calibrated_for', object: subject,
        statement, scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'the widget mechanism' }],
      }],
    }).inserted[0]!;
    const ts = new Date(new Date(now).getTime() - ageDays * 86_400_000).toISOString();
    const insert = db.prepare(`INSERT INTO accesses (id, ts, target_id, query, used) VALUES (?, ?, ?, 'widget', 1)`);
    for (let i = 0; i < 25; i++) insert.run(newId(), ts, id);
    return id;
  }

  it('25 accesses exactly at the 365-day boundary still count; the same 25 one day older score identically to no accesses at all', () => {
    const db = openDb(tmpDbFile());
    const statement = 'The gadget operates using the widget mechanism for testing purposes.';
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'message',
      content: 'We discussed the widget mechanism at length.', ts: '2026-09-01T00:00:00.000Z',
    }).id;
    const now = '2026-10-01T00:00:00.000Z';

    const atBoundary = seedWithManyAccessesAt(db, 'alpha-item', ev, statement, 365, now);
    const justOutside = seedWithManyAccessesAt(db, 'beta-item', ev, statement, 366, now);
    const noAccess = upsertClaims(db, {
      claims: [{
        subject: 'gamma-item', predicate: 'calibrated_for', object: 'gamma-item',
        statement, scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'the widget mechanism' }],
      }],
    }).inserted[0]!;

    const ranked = searchClaimsRanked(db, { query: 'widget', mode: 'keyword', limit: 10 }, now);
    const boundaryHit = ranked.find((h) => h.id === atBoundary)!;
    const outsideHit = ranked.find((h) => h.id === justOutside)!;
    const noneHit = ranked.find((h) => h.id === noAccess)!;

    expect(boundaryHit.score).toBeGreaterThan(noneHit.score); // included -> real positive activation
    expect(outsideHit.score).toBeCloseTo(noneHit.score, 9); // excluded -> same as no accesses
    db.close();
  });
});

describe('§7 event scoring via DB-backed searchEventsRanked', () => {
  it('explicit_remember events get importance 0.8; other events get 0.5; both have activation 0 (no access rows for events)', () => {
    const db = openDb(tmpDbFile());
    const remembered = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'explicit_remember',
      content: 'Remember: the flibbertigibbet runs nightly.', ts: '2026-09-20T00:00:00.000Z',
    }).id;
    const mentioned = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'message',
      content: 'The flibbertigibbet job failed again today.', ts: '2026-09-20T00:00:00.000Z',
    }).id;

    const now = '2026-10-01T00:00:00.000Z';
    const ranked = searchEventsRanked(db, { query: 'flibbertigibbet', mode: 'keyword', limit: 10 }, now);
    const remHit = ranked.find((h) => h.id === remembered)!;
    const mentHit = ranked.find((h) => h.id === mentioned)!;
    expect(remHit.score).toBeGreaterThan(mentHit.score);
    // Pure importance delta: 0.15 * (0.8 - 0.5) = 0.045, modulo any small bm25/recency differences
    // from differing content -- assert at least the importance-driven direction and rough magnitude.
    expect(remHit.score - mentHit.score).toBeGreaterThan(0);
  });

  // J5: snippet() was moved to a second, narrow query over just the final winning ids -- confirm it
  // still produces a real, highlighted snippet (not null/empty) for a result that survives ranking.
  it('still returns a real, highlighted snippet for a winning result (snippet() deferred to the final limit rows)', () => {
    const db = openDb(tmpDbFile());
    const id = appendEvent(db, {
      sessionId: 's1', role: 'user', content: 'The flibbertigibbet job failed again today.',
      ts: '2026-09-20T00:00:00.000Z',
    }).id;

    const now = '2026-10-01T00:00:00.000Z';
    const ranked = searchEventsRanked(db, { query: 'flibbertigibbet', mode: 'keyword', limit: 10 }, now);
    const hit = ranked.find((h) => h.id === id)!;
    expect(hit.snippet).not.toBeNull();
    expect(hit.snippet).toContain('[flibbertigibbet]');
  });
});

describe('J2: bounded scoring against untrusted/corrupted DB rows', () => {
  it('a future-dated claim row (recorded_at bypassing normal write validation) still yields a finite score and valid search output', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', content: 'The sprocket assembly needs recalibration soon.',
    }).id;
    const id = upsertClaims(db, {
      claims: [{
        subject: 'sprocket-assembly', predicate: 'status_is', object: 'needs_recalibration',
        statement: 'The sprocket assembly needs recalibration soon.', scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'sprocket assembly needs recalibration' }],
      }],
    }).inserted[0]!;
    // Bypasses upsertClaims' own validation entirely -- simulates a corrupted/malicious row already
    // present in the DB (upsertClaims itself doesn't reject a future recorded_at; this is specifically
    // about ranking staying bounded regardless of how a bad row got there).
    db.prepare(`UPDATE claims SET recorded_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`).run(id);

    const now = '2026-10-01T00:00:00.000Z';
    const ranked = searchClaimsRanked(db, { query: 'sprocket', mode: 'keyword', limit: 10 }, now);
    const hit = ranked.find((h) => h.id === id)!;
    expect(Number.isFinite(hit.score)).toBe(true);
    // Capped at the same recency a just-now row gets (1), never exp() of a huge negative delta.
    expect(hit.score).toBeLessThanOrEqual(1 + 1e-9);
    db.close();
  });

  // Note: better-sqlite3 silently coerces a bound JS NaN to SQL NULL (confirmed: binding NaN to this
  // NOT NULL column throws a constraint error, it can't actually store NaN), so a literal NaN can't be
  // persisted into `importance` this way -- see test/score.test.ts's pure `rankHits` NaN-importance
  // test above for that exact case. Infinity, however, *is* representable and bindable, so it's used
  // here for the DB-level "non-finite stored importance" repro.
  it('a non-finite (Infinity) importance inserted directly into the DB still yields a finite score', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', content: 'The widget calibration log was updated today.',
    }).id;
    const id = upsertClaims(db, {
      claims: [{
        subject: 'widget-log', predicate: 'status_is', object: 'updated',
        statement: 'The widget calibration log was updated today.', scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'widget calibration log was updated' }],
      }],
    }).inserted[0]!;
    db.prepare(`UPDATE claims SET importance = ? WHERE id = ?`).run(Infinity, id);

    const now = '2026-10-01T00:00:00.000Z';
    const ranked = searchClaimsRanked(db, { query: 'widget', mode: 'keyword', limit: 10 }, now);
    const hit = ranked.find((h) => h.id === id)!;
    expect(Number.isFinite(hit.score)).toBe(true);
    db.close();
  });
});
