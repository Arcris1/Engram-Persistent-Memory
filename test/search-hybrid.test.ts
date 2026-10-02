import { beforeEach, describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { createFakeEmbedder } from '../src/embed/fake.js';
import { upsertEmbedding } from '../src/embed/store.js';
import { appendEvent } from '../src/events/events.js';
import { searchClaimsRanked } from '../src/search/claims.js';
import { searchEventsRanked } from '../src/search/events.js';
import { openDb, type Db } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

const fake = createFakeEmbedder();

function negate(v: Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = -v[i]!;
  return out;
}

/**
 * Phase 6 Task 3 (D42/hybrid): integration tests over the real `searchClaimsRanked`/
 * `searchEventsRanked` hybrid admission + relevance path, using the fake embedder so cosine is
 * deterministic without a real model. The disabled path (no `queryVector`) is already exercised
 * byte-identically by the full pre-existing suite; these tests cover what Phase 6 adds on top.
 */
describe('hybrid search: admission (cosine >= tau OR gate A)', () => {
  let db: Db;
  let claimMatchId: string;
  let claimVectorHighId: string;
  let claimVectorLowId: string;

  beforeEach(async () => {
    db = openDb(tmpDbFile());
    const ev = appendEvent(db, {
      sessionId: 's', role: 'user',
      content: 'Uses PostgreSQL for billing. Totally unrelated xyz content. Another unrelated abc content.',
    }).id;

    const insert = (subject: string, statement: string) => {
      const r = upsertClaims(db, {
        claims: [{
          subject, predicate: 'uses', object: 'thing', statement, scope: 'fact', confidence: 0.9,
          sources: [{ event_id: ev, excerpt: statement }],
        }],
      });
      if (r.rejected.length > 0) throw new Error(`setup: claim rejected: ${r.rejected[0]!.reason}`);
      return r.inserted[0]!;
    };

    // Lexically matches the query ("postgresql") and passes gate A on that alone -- never embedded,
    // so it must be admitted purely via gate A, with cosine null in the output.
    claimMatchId = insert('claim:match', 'Uses PostgreSQL for billing.');
    // Shares NO terms with the query at all (fails both the FTS match and gate A) -- admitted only
    // because its stored vector is crafted to be cosine=1 against the query embedding.
    claimVectorHighId = insert('claim:vector-high', 'Totally unrelated xyz content.');
    // Also shares no terms with the query, AND its stored vector is crafted to be cosine=-1 -- must
    // be excluded entirely (fails both admission paths).
    claimVectorLowId = insert('claim:vector-low', 'Another unrelated abc content.');
  });

  it('admits a gate-A lexical match with no stored vector at all (no cosine key in the hit)', async () => {
    const queryVector = (await fake.embed(['postgresql']))[0]!;
    const hits = searchClaimsRanked(db, { query: 'postgresql', mode: 'keyword', limit: 10, queryVector, tau: 0.5 }, '2026-10-02T00:00:00Z');
    const match = hits.find((h) => h.id === claimMatchId);
    expect(match).toBeDefined();
    expect('cosine' in match!).toBe(false);
  });

  it('admits a vector-only candidate (no lexical overlap) whose cosine clears tau, and excludes one that does not', async () => {
    const queryVector = (await fake.embed(['postgresql']))[0]!;
    upsertEmbedding(db, { target_kind: 'claim', target_id: claimVectorHighId, model: 'fake', content_hash: 'h1', vec: queryVector });
    upsertEmbedding(db, { target_kind: 'claim', target_id: claimVectorLowId, model: 'fake', content_hash: 'h2', vec: negate(queryVector) });

    const hits = searchClaimsRanked(db, { query: 'postgresql', mode: 'keyword', limit: 10, queryVector, tau: 0.5 }, '2026-10-02T00:00:00Z');
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(claimMatchId);
    expect(ids).toContain(claimVectorHighId);
    expect(ids).not.toContain(claimVectorLowId);

    const vectorHigh = hits.find((h) => h.id === claimVectorHighId)!;
    expect(vectorHigh.cosine).toBeCloseTo(1, 6);
  });

  it('with queryVector omitted (disabled/non-hybrid path), only the lexical match is returned and no hit carries a cosine key', () => {
    const hits = searchClaimsRanked(db, { query: 'postgresql', mode: 'keyword', limit: 10 }, '2026-10-02T00:00:00Z');
    expect(hits.map((h) => h.id)).toEqual([claimMatchId]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !('cosine' in h))).toBe(true);
  });
});

describe('hybrid search: events are embedded too', () => {
  let db: Db;
  let eventMatchId: string;
  let eventVectorHighId: string;
  let eventVectorLowId: string;

  beforeEach(() => {
    db = openDb(tmpDbFile());
    eventMatchId = appendEvent(db, { sessionId: 's', role: 'user', content: 'Deployed the postgresql migration today.' }).id;
    eventVectorHighId = appendEvent(db, { sessionId: 's', role: 'user', content: 'Totally unrelated xyz content.' }).id;
    eventVectorLowId = appendEvent(db, { sessionId: 's', role: 'user', content: 'Another unrelated abc content.' }).id;
  });

  it('admits a lexical match (gate A) and a cosine-admitted vector-only event, excludes a low-cosine one', async () => {
    const queryVector = (await fake.embed(['postgresql']))[0]!;
    upsertEmbedding(db, { target_kind: 'event', target_id: eventVectorHighId, model: 'fake', content_hash: 'h1', vec: queryVector });
    upsertEmbedding(db, { target_kind: 'event', target_id: eventVectorLowId, model: 'fake', content_hash: 'h2', vec: negate(queryVector) });

    const hits = searchEventsRanked(db, { query: 'postgresql', mode: 'keyword', limit: 10, queryVector, tau: 0.5 }, '2026-10-02T00:00:00Z');
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(eventMatchId);
    expect(ids).toContain(eventVectorHighId);
    expect(ids).not.toContain(eventVectorLowId);
  });
});

describe('hybrid search: model/dim identity (Phase 6 review)', () => {
  async function setup(storedModel: string, storedVec: (q: Float32Array) => Float32Array) {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Totally unrelated xyz content.' });
    const queryVector = (await fake.embed(['postgresql']))[0]!;
    upsertEmbedding(db, {
      target_kind: 'event', target_id: ev.id, model: storedModel, content_hash: (db.prepare('SELECT content_hash FROM events WHERE id = ?').pluck().get(ev.id) as string), vec: storedVec(queryVector),
    });
    return { db, queryVector, id: ev.id };
  }
  const run = (db: Db, queryVector: Float32Array, queryModel: string) =>
    searchEventsRanked(db, { query: 'postgresql', mode: 'keyword', limit: 10, queryVector, queryModel, tau: 0.5 }, '2026-10-02T00:00:00Z');

  it('a vector stored by the same model and dim is compared (control)', async () => {
    const { db, queryVector, id } = await setup('fake', (q) => q);
    expect(run(db, queryVector, 'fake').map((h) => h.id)).toEqual([id]);
  });

  it('a vector stored under a different model is treated as missing, not compared', async () => {
    const { db, queryVector } = await setup('other-model@12345678', (q) => q);
    expect(run(db, queryVector, 'fake')).toEqual([]);
  });

  it('a vector whose dim differs from the query vector is treated as missing, not compared', async () => {
    const { db, queryVector } = await setup('fake', (q) => q.slice(0, 8));
    expect(run(db, queryVector, 'fake')).toEqual([]);
  });
});
