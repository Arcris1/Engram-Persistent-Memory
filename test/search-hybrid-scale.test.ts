import { describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { createFakeEmbedder } from '../src/embed/fake.js';
import { upsertEmbedding } from '../src/embed/store.js';
import { appendEvent } from '../src/events/events.js';
import { searchClaimsRanked } from '../src/search/claims.js';
import { searchEventsRanked } from '../src/search/events.js';
import { openDb } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

const fake = createFakeEmbedder();
const NOW = '2026-10-02T00:00:00Z';

/**
 * Phase 6 review (Important #4): candidate vectors are selected by a JOIN that re-applies the search
 * filters in SQL, not by binding every filtered id into an IN-list (SQLite caps bound variables at
 * 32,766, so a large store made hybrid search throw "too many SQL variables").
 */
describe('hybrid search: vector candidates are filtered in SQL', () => {
  it('succeeds with more than 32,766 embedded events and returns the vector-only top hit', async () => {
    const db = openDb(tmpDbFile());
    const q = (await fake.embed(['kubernetes ingress']))[0]!;
    const N = 33_000;
    const insEv = db.prepare(
      `INSERT INTO events (id, ts, session_id, role, content, content_hash) VALUES (?, ?, 's', 'user', ?, ?)`,
    );
    const insEmb = db.prepare(
      `INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at)
       VALUES ('event', ?, 'fake', ?, 384, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const v = new Float32Array(384);
        v[i % 384] = 1;
        const vec = i === 12_345 ? q : v;
        insEv.run(`ev${i}`, '2026-10-01T00:00:00Z', `filler ${i}`, `h${i}`);
        insEmb.run(`ev${i}`, `h${i}`, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), NOW);
      }
    })();

    const hits = searchEventsRanked(db, { query: 'kubernetes ingress', mode: 'keyword', limit: 5, queryVector: q, tau: 0.45 }, NOW);
    expect(hits[0]?.id).toBe('ev12345');
    expect(hits[0]?.cosine).toBeCloseTo(1, 4);
  });

  it('still excludes vector-only events from another project or outside the time range', async () => {
    const db = openDb(tmpDbFile());
    const q = (await fake.embed(['kubernetes ingress']))[0]!;
    const mk = (content: string, project: string, ts: string) => {
      const id = appendEvent(db, { sessionId: 's', role: 'user', content, project, ts }).id;
      upsertEmbedding(db, { target_kind: 'event', target_id: id, model: 'fake', content_hash: 'h', vec: q });
      return id;
    };
    const keep = mk('alpha one', 'p1', '2026-09-30T12:00:00Z');
    const otherProject = mk('beta two', 'p2', '2026-09-30T12:00:00Z');
    const early = mk('gamma three', 'p1', '2026-01-01T00:00:00Z');
    const hits = searchEventsRanked(
      db,
      { query: 'kubernetes ingress', mode: 'keyword', limit: 10, queryVector: q, tau: 0.45, project: 'p1', since: '2026-09-01' },
      NOW,
    );
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(otherProject);
    expect(ids).not.toContain(early);
  });

  it('still excludes vector-only claims that are not active', async () => {
    const db = openDb(tmpDbFile());
    const q = (await fake.embed(['kubernetes ingress']))[0]!;
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Totally unrelated words here.' }).id;
    const ins = (subject: string): string => {
      const r = upsertClaims(db, {
        claims: [{
          subject, predicate: 'uses', object: 'thing', statement: `Unrelated statement ${subject}.`, scope: 'fact', confidence: 0.9,
          sources: [{ event_id: ev, excerpt: 'Totally unrelated words here.' }],
        }],
      });
      return r.inserted[0]!;
    };
    const active = ins('c:active');
    const dead = ins('c:dead');
    db.prepare(`UPDATE claims SET status = 'superseded' WHERE id = ?`).run(dead);
    for (const id of [active, dead]) {
      upsertEmbedding(db, { target_kind: 'claim', target_id: id, model: 'fake', content_hash: 'h', vec: q });
    }
    const ids = searchClaimsRanked(db, { query: 'kubernetes ingress', mode: 'keyword', limit: 10, queryVector: q, tau: 0.45 }, NOW).map((h) => h.id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(dead);
  });
});
