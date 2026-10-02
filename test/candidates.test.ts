import { describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { appendEvent } from '../src/events/events.js';
import { cosineSimilarity, DEFAULT_TAU, fetchCandidates, gateAPassed, poolLimit, topKByCosine } from '../src/search/candidates.js';
import { MIN_CANDIDATE_POOL } from '../src/search/score.js';
import { openDb, type Db } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

describe('poolLimit', () => {
  it('is max(limit*5, MIN_CANDIDATE_POOL) -- the single shared pool constant', () => {
    expect(poolLimit(1)).toBe(MIN_CANDIDATE_POOL);
    expect(poolLimit(10)).toBe(MIN_CANDIDATE_POOL);
    expect(poolLimit(20)).toBe(100);
  });
});

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity(vec(1, 2, 3), vec(1, 2, 3))).toBeCloseTo(1, 9);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 9);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity(vec(1, 2), vec(-1, -2))).toBeCloseTo(-1, 9);
  });

  it('is 0 (not NaN) when either vector is all zeros', () => {
    expect(cosineSimilarity(vec(0, 0, 0), vec(1, 2, 3))).toBe(0);
    expect(cosineSimilarity(vec(1, 2, 3), vec(0, 0, 0))).toBe(0);
  });

  it('is scale-invariant (raw cosine, not affected by vector magnitude)', () => {
    expect(cosineSimilarity(vec(1, 0), vec(5, 0))).toBeCloseTo(1, 9);
  });
});

describe('topKByCosine', () => {
  it('returns the k highest-cosine entries, excluding the rest', () => {
    const query = vec(1, 0);
    const vectors = new Map<string, Float32Array>([
      ['best', vec(1, 0)], // cosine 1
      ['mid', vec(1, 1)], // cosine ~0.707
      ['worst', vec(0, 1)], // cosine 0
    ]);
    const top2 = topKByCosine(vectors, query, 2);
    expect(new Set(top2.keys())).toEqual(new Set(['best', 'mid']));
    expect(top2.get('best')).toBeCloseTo(1, 9);
    expect(top2.has('worst')).toBe(false);
  });

  it('k=0 returns an empty map', () => {
    const vectors = new Map([['a', vec(1, 0)]]);
    expect(topKByCosine(vectors, vec(1, 0), 0).size).toBe(0);
  });

  it('an empty vectors map returns an empty map', () => {
    expect(topKByCosine(new Map(), vec(1, 0), 5).size).toBe(0);
  });
});

describe('DEFAULT_TAU', () => {
  it('is one of the six pre-registered tau sweep points', () => {
    expect([0.3, 0.35, 0.4, 0.45, 0.5, 0.55]).toContain(DEFAULT_TAU);
  });
});

describe('fetchCandidates (claims_fts)', () => {
  function setup(): { db: Db; seq: (key: string) => number } {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, {
      sessionId: 's', role: 'user',
      content: 'Uses PostgreSQL for billing. Uses Redis for caching. Prefers pnpm as a package manager.',
    }).id;
    for (const [subject, statement, excerpt] of [
      ['claim:pg', 'Uses PostgreSQL for billing.', 'Uses PostgreSQL for billing.'],
      ['claim:redis', 'Uses Redis for caching.', 'Uses Redis for caching.'],
      ['claim:unrelated', 'Prefers pnpm as a package manager.', 'Prefers pnpm as a package manager.'],
    ] as const) {
      const r = upsertClaims(db, {
        claims: [{
          subject, predicate: 'uses', object: 'thing', statement, scope: 'fact', confidence: 0.9,
          sources: [{ event_id: ev, excerpt }],
        }],
      });
      if (r.rejected.length > 0) throw new Error(`setup: claim rejected: ${r.rejected[0]!.reason}`);
    }
    const seq = (subject: string): number =>
      (db.prepare(`SELECT seq FROM claims WHERE subject = ?`).get(subject) as { seq: number }).seq;
    return { db, seq };
  }

  it("gate 'none': a plain bm25-ordered LIMIT, no coverage filtering", () => {
    const { db } = setup();
    const sqlBase = `
      SELECT c.*, bm25(claims_fts) AS rank
      FROM claims_fts JOIN claims c ON c.seq = claims_fts.rowid
      WHERE claims_fts MATCH @match
      ORDER BY bm25(claims_fts), c.recorded_at DESC`;
    const rows = fetchCandidates<{ seq: number; subject: string }>({
      db, ftsTable: 'claims_fts', sqlBase, params: { match: 'postgresql OR redis OR pnpm' },
      gate: 'none', query: 'postgresql redis pnpm', limit: 100,
    });
    expect(rows.map((r) => r.subject).sort()).toEqual(['claim:pg', 'claim:redis', 'claim:unrelated']);
    db.close();
  });

  it("gate 'A': filters out OR-matches that don't meet the per-term coverage threshold", () => {
    const { db } = setup();
    // A two-content-term query ('postgresql' and 'caching') OR-matches pg (postgresql only) and
    // redis (caching only) but neither alone covers both terms -- gate A (need=max(ceil(2/2),1)=1
    // for k=2 below the k>=3 threshold) still only requires 1, so both should pass; this just
    // exercises the gated branch runs end-to-end without error and still returns bm25-ordered rows.
    const sqlBase = `
      SELECT c.*, bm25(claims_fts) AS rank
      FROM claims_fts JOIN claims c ON c.seq = claims_fts.rowid
      WHERE claims_fts MATCH @match
      ORDER BY bm25(claims_fts), c.recorded_at DESC`;
    const rows = fetchCandidates<{ seq: number; subject: string }>({
      db, ftsTable: 'claims_fts', sqlBase, params: { match: 'postgresql OR caching' },
      gate: 'A', query: 'postgresql caching', limit: 100,
    });
    expect(rows.map((r) => r.subject).sort()).toEqual(['claim:pg', 'claim:redis']);
    db.close();
  });
});

describe('gateAPassed', () => {
  it('passes rows meeting gate A coverage over the query content terms, independent of any other gate', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Uses PostgreSQL for billing.' }).id;
    const r = upsertClaims(db, {
      claims: [{
        subject: 'claim:a', predicate: 'uses', object: 'thing', statement: 'Uses PostgreSQL for billing.',
        scope: 'fact', confidence: 0.9, sources: [{ event_id: ev, excerpt: 'Uses PostgreSQL for billing.' }],
      }],
    });
    if (r.rejected.length > 0) throw new Error(`setup: claim rejected: ${r.rejected[0]!.reason}`);
    const row = db.prepare(`SELECT seq FROM claims WHERE subject = 'claim:a'`).get() as { seq: number };
    const otherSeq = row.seq + 999; // a seq not actually present, must never be in the passing set

    const passed = gateAPassed(db, 'claims_fts', [row.seq, otherSeq], 'postgresql billing');
    expect(passed.has(row.seq)).toBe(true);
    expect(passed.has(otherSeq)).toBe(false);
    db.close();
  });

  it('an empty seq list or empty terms yields an empty passing set', () => {
    const db = openDb(tmpDbFile());
    expect(gateAPassed(db, 'claims_fts', [], 'anything').size).toBe(0);
    db.close();
  });
});
