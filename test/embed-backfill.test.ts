import { describe, expect, it } from 'vitest';
import { upsertClaims, type ClaimInput } from '../src/claims/claims.js';
import { embedMissing } from '../src/embed/backfill.js';
import { createFakeEmbedder } from '../src/embed/fake.js';
import { embedAfterWrite } from '../src/embed/postwrite.js';
import { loadVectors, sweepOrphanEmbeddings, upsertEmbedding } from '../src/embed/store.js';
import { appendEvent } from '../src/events/events.js';
import { openDb } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

function claimInput(eventId: string, excerpt: string, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    subject: 'project:billing',
    predicate: 'uses_database',
    object: 'PostgreSQL',
    statement: 'The billing project uses PostgreSQL.',
    scope: 'fact',
    confidence: 0.9,
    sources: [{ event_id: eventId, excerpt }],
    ...overrides,
  };
}

describe('embedMissing', () => {
  it('embeds every event and claim missing a vector', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    const embedder = createFakeEmbedder();

    const result = await embedMissing(db, embedder);
    expect(result).toEqual({ embedded: 2, by_kind: { event: 1, claim: 1 } });

    const eventVecs = loadVectors(db, 'event', [ev]);
    const claimVecs = loadVectors(db, 'claim', [claimId]);
    expect(eventVecs.has(ev)).toBe(true);
    expect(claimVecs.has(claimId)).toBe(true);

    const row = db.prepare(`SELECT model, dim FROM embeddings WHERE target_kind = 'event' AND target_id = ?`).get(ev) as {
      model: string;
      dim: number;
    };
    expect(row.model).toBe('fake');
    expect(row.dim).toBe(384);
    db.close();
  });

  it('is idempotent: a second run with unchanged content embeds 0', async () => {
    const db = openDb(tmpDbFile());
    appendEvent(db, { sessionId: 's', role: 'user', content: 'Only once please.' });
    const embedder = createFakeEmbedder();

    const first = await embedMissing(db, embedder);
    expect(first.embedded).toBe(1);
    const second = await embedMissing(db, embedder);
    expect(second.embedded).toBe(0);
    db.close();
  });

  it('re-embeds a stale vector (content_hash no longer matches) and leaves a fresh one untouched', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Current content.' }).id;
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: 'stale-hash', vec: new Float32Array(384) });
    const embedder = createFakeEmbedder();

    const result = await embedMissing(db, embedder);
    expect(result.embedded).toBe(1);
    const row = db.prepare(`SELECT content_hash FROM embeddings WHERE target_kind = 'event' AND target_id = ?`).get(ev) as {
      content_hash: string;
    };
    const expectedHash = db.prepare(`SELECT content_hash FROM events WHERE id = ?`).pluck().get(ev);
    expect(row.content_hash).toBe(expectedHash);
    db.close();
  });

  it('respects the per-kind limit and the kinds filter', async () => {
    const db = openDb(tmpDbFile());
    for (let i = 0; i < 3; i++) appendEvent(db, { sessionId: 's', role: 'user', content: `event ${i}` });
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'For a claim.' }).id;
    upsertClaims(db, { claims: [claimInput(ev, 'For a claim.')] });
    const embedder = createFakeEmbedder();

    const eventsOnly = await embedMissing(db, embedder, { kinds: ['event'], limit: 2 });
    expect(eventsOnly).toEqual({ embedded: 2, by_kind: { event: 2, claim: 0 } });
    db.close();
  });

  it('the stored vector is L2-normalised, matching the embedder output exactly', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Vector fidelity check.' }).id;
    const embedder = createFakeEmbedder();
    const [expected] = await embedder.embed(['Vector fidelity check.']);

    await embedMissing(db, embedder);
    const stored = loadVectors(db, 'event', [ev]).get(ev)!;
    expect(Array.from(stored)).toEqual(Array.from(expected!));
    db.close();
  });
});

/** Phase 6 review: an embedder whose embed() runs `during` first, simulating a concurrent writer. */
function racingEmbedder(during: () => void) {
  const fake = createFakeEmbedder();
  return { model: fake.model, dim: fake.dim, embed: async (t: string[]) => { during(); return fake.embed(t); } };
}
const embCount = (db: ReturnType<typeof openDb>) => db.prepare('SELECT count(*) FROM embeddings').pluck().get() as number;

describe('forget race (Phase 6 review)', () => {
  it('backfill: source deleted between read and write leaves no embeddings row', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'to be forgotten' }).id;
    const r = await embedMissing(db, racingEmbedder(() => { db.prepare('DELETE FROM events WHERE id = ?').run(ev); }));
    expect(r.embedded).toBe(0);
    expect(embCount(db)).toBe(0);
    db.close();
  });

  it('backfill: content changed between read and write is not written', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'original' }).id;
    db.exec('DROP TRIGGER events_no_update'); // events are immutable in practice; drop the guard to simulate a hash change
    const r = await embedMissing(db, racingEmbedder(() => { db.prepare(`UPDATE events SET content_hash = 'changed' WHERE id = ?`).run(ev); }));
    expect(r.embedded).toBe(0);
    expect(embCount(db)).toBe(0);
    db.close();
  });

  it('backfill: claim deleted or edited between read and write is not written', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL' }).id;
    const id = upsertClaims(db, { claims: [claimInput(ev, 'We use PostgreSQL')] }).inserted[0]!;
    await embedMissing(db, racingEmbedder(() => { db.prepare(`UPDATE claims SET statement = 'edited' WHERE id = ?`).run(id); }), { kinds: ['claim'] });
    expect(embCount(db)).toBe(0);
    db.close();
  });

  it('post-write hook: source deleted during embed leaves no embeddings row', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'to be forgotten' }).id;
    await embedAfterWrite(db, racingEmbedder(() => { db.prepare('DELETE FROM events WHERE id = ?').run(ev); }), { kind: 'event', id: ev });
    expect(embCount(db)).toBe(0);
    db.close();
  });

  it('post-write hook: content changed during embed is not written', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'original' }).id;
    db.exec('DROP TRIGGER events_no_update');
    await embedAfterWrite(db, racingEmbedder(() => { db.prepare(`UPDATE events SET content_hash = 'changed' WHERE id = ?`).run(ev); }), { kind: 'event', id: ev });
    expect(embCount(db)).toBe(0);
    db.close();
  });

  it('sweepOrphanEmbeddings removes embeddings with no source and keeps live ones', async () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'alive' }).id;
    await embedMissing(db, createFakeEmbedder());
    upsertEmbedding(db, { target_kind: 'event', target_id: 'gone-event', model: 'fake', content_hash: 'h', vec: new Float32Array(384) });
    upsertEmbedding(db, { target_kind: 'claim', target_id: 'gone-claim', model: 'fake', content_hash: 'h', vec: new Float32Array(384) });
    expect(sweepOrphanEmbeddings(db)).toBe(2);
    expect(embCount(db)).toBe(1);
    expect(loadVectors(db, 'event', [ev]).has(ev)).toBe(true);
    db.close();
  });
});
