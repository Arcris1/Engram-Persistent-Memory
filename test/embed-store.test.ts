import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { upsertClaims, type ClaimInput } from '../src/claims/claims.js';
import { appendEvent } from '../src/events/events.js';
import {
  claimContentHash, claimEmbedText, countMissingOrStale, forEachFilteredVector, loadVectors, missingOrStale, upsertEmbedding, upsertEmbeddingIfCurrent,
} from '../src/embed/store.js';
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

function vec(fill: number, dim = 384): Float32Array {
  return new Float32Array(dim).fill(fill);
}

describe('claimContentHash / claimEmbedText', () => {
  it('hash is sha256(subject + statement + object), order fixed', () => {
    const h1 = claimContentHash('subject-a', 'statement-b', 'object-c');
    const h2 = claimContentHash('subject-a', 'statement-b', 'object-c');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Changing any one field changes the hash.
    expect(claimContentHash('subject-x', 'statement-b', 'object-c')).not.toBe(h1);
    expect(claimContentHash('subject-a', 'statement-x', 'object-c')).not.toBe(h1);
    expect(claimContentHash('subject-a', 'statement-b', 'object-x')).not.toBe(h1);
  });

  it('embed text includes the statement, subject and object', () => {
    const text = claimEmbedText('project:billing', 'Uses PostgreSQL.', 'PostgreSQL');
    expect(text).toContain('Uses PostgreSQL.');
    expect(text).toContain('project:billing');
    expect(text).toContain('PostgreSQL');
  });
});

describe('upsertEmbedding / loadVectors round trip', () => {
  it('stores and reads back a Float32Array vector byte-for-byte', () => {
    const db = openDb(tmpDbFile());
    const v = vec(0.5, 8);
    upsertEmbedding(db, { target_kind: 'event', target_id: 'e1', model: 'fake', content_hash: 'h1', vec: v });

    const loaded = loadVectors(db, 'event', ['e1']);
    expect(loaded.size).toBe(1);
    expect(Array.from(loaded.get('e1')!)).toEqual(Array.from(v));
    db.close();
  });

  it('a second upsert for the same target replaces the row instead of erroring or duplicating', () => {
    const db = openDb(tmpDbFile());
    upsertEmbedding(db, { target_kind: 'claim', target_id: 'c1', model: 'fake', content_hash: 'h1', vec: vec(0.1, 4) });
    upsertEmbedding(db, { target_kind: 'claim', target_id: 'c1', model: 'fake', content_hash: 'h2', vec: vec(0.9, 4) });

    const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(1);
    const row = db.prepare(`SELECT content_hash FROM embeddings WHERE target_kind = 'claim' AND target_id = 'c1'`).get() as {
      content_hash: string;
    };
    expect(row.content_hash).toBe('h2');
    const loaded = loadVectors(db, 'claim', ['c1']);
    expect(Array.from(loaded.get('c1')!)).toEqual(Array.from(vec(0.9, 4)));
    db.close();
  });

  it('loadVectors without ids returns every vector of that kind; with an empty id list returns none', () => {
    const db = openDb(tmpDbFile());
    upsertEmbedding(db, { target_kind: 'event', target_id: 'e1', model: 'fake', content_hash: 'h1', vec: vec(0.2, 4) });
    upsertEmbedding(db, { target_kind: 'event', target_id: 'e2', model: 'fake', content_hash: 'h2', vec: vec(0.3, 4) });
    upsertEmbedding(db, { target_kind: 'claim', target_id: 'c1', model: 'fake', content_hash: 'h3', vec: vec(0.4, 4) });

    const allEvents = loadVectors(db, 'event');
    expect(new Set(allEvents.keys())).toEqual(new Set(['e1', 'e2']));
    expect(loadVectors(db, 'event', [])).toEqual(new Map());
    db.close();
  });
});

describe('missingOrStale', () => {
  it('events: finds an event with no embedding yet', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Needs embedding.' }).id;

    const targets = missingOrStale(db, 'event', 10);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: 'event', id: ev, text: 'Needs embedding.' });
    db.close();
  });

  it('events: excludes an event whose embedding content_hash already matches', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Already embedded.' }).id;
    const row = db.prepare(`SELECT content_hash FROM events WHERE id = ?`).get(ev) as { content_hash: string };
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: row.content_hash, vec: vec(0.1) });

    expect(missingOrStale(db, 'event', 10)).toEqual([]);
    db.close();
  });

  it('events: includes a stale embedding (content_hash no longer matches, e.g. a reused id with new content_hash recorded)', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Original text.' }).id;
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: 'stale-hash', vec: vec(0.1) });

    const targets = missingOrStale(db, 'event', 10);
    expect(targets.map((t) => t.id)).toEqual([ev]);
    db.close();
  });

  it('events: respects the limit', () => {
    const db = openDb(tmpDbFile());
    for (let i = 0; i < 5; i++) appendEvent(db, { sessionId: 's', role: 'user', content: `event ${i}` });
    expect(missingOrStale(db, 'event', 2)).toHaveLength(2);
    db.close();
  });

  it('claims: finds a claim with no embedding yet, text includes statement/subject/object', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    const targets = missingOrStale(db, 'claim', 10);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(claimId);
    expect(targets[0]!.text).toContain('PostgreSQL');
    expect(targets[0]!.content_hash).toBe(claimContentHash('project:billing', 'The billing project uses PostgreSQL.', 'PostgreSQL'));
    db.close();
  });

  it('claims: excludes a claim already embedded with a matching hash; includes one with a stale hash', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    const freshHash = claimContentHash('project:billing', 'The billing project uses PostgreSQL.', 'PostgreSQL');
    upsertEmbedding(db, { target_kind: 'claim', target_id: claimId, model: 'fake', content_hash: freshHash, vec: vec(0.1) });
    expect(missingOrStale(db, 'claim', 10)).toEqual([]);

    upsertEmbedding(db, { target_kind: 'claim', target_id: claimId, model: 'fake', content_hash: 'stale', vec: vec(0.1) });
    expect(missingOrStale(db, 'claim', 10).map((t) => t.id)).toEqual([claimId]);
    db.close();
  });
});

describe('model identity (Phase 6 review)', () => {
  it('missingOrStale treats a vector stored under a different model as stale (events and claims)', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL.' });
    const r = upsertClaims(db, { claims: [claimInput(ev.id, 'We use PostgreSQL.')] });
    const claimId = r.inserted[0]!;
    const claim = db.prepare('SELECT subject, statement, object FROM claims WHERE id = ?').get(claimId) as {
      subject: string; statement: string; object: string;
    };
    upsertEmbedding(db, { target_kind: 'event', target_id: ev.id, model: 'm@aaaaaaaa', content_hash: (db.prepare('SELECT content_hash FROM events WHERE id = ?').pluck().get(ev.id) as string), vec: vec(1, 4) });
    upsertEmbedding(db, {
      target_kind: 'claim', target_id: claimId, model: 'm@aaaaaaaa',
      content_hash: claimContentHash(claim.subject, claim.statement, claim.object), vec: vec(1, 4),
    });

    // same model (or no model given): nothing is stale
    expect(missingOrStale(db, 'event', 10, false, 'm@aaaaaaaa')).toEqual([]);
    expect(missingOrStale(db, 'claim', 10, false, 'm@aaaaaaaa')).toEqual([]);
    expect(missingOrStale(db, 'event', 10)).toEqual([]);
    // a different model hash prefix: both are stale
    expect(missingOrStale(db, 'event', 10, false, 'm@bbbbbbbb').map((t) => t.id)).toEqual([ev.id]);
    expect(missingOrStale(db, 'claim', 10, false, 'm@bbbbbbbb').map((t) => t.id)).toEqual([claimId]);
    db.close();
  });
});

describe('upsertEmbeddingIfCurrent locking (Phase 6 re-review)', () => {
  function seed() {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Guarded write.' });
    const content_hash = db.prepare('SELECT content_hash FROM events WHERE id = ?').pluck().get(ev.id) as string;
    return { db, input: { target_kind: 'event' as const, target_id: ev.id, model: 'm', content_hash, vec: vec(1, 4) } };
  }

  // SQLite skips the busy handler on a read->write lock upgrade, so the guarded read-then-write must
  // BEGIN IMMEDIATE. Deterministic proof: spy on db.transaction and record which variant is invoked.
  it('runs its read-then-write transaction as IMMEDIATE, never deferred', () => {
    const { db, input } = seed();
    const calls: string[] = [];
    const real = db.transaction.bind(db) as (fn: () => unknown) => ((...a: unknown[]) => unknown) & { immediate: () => unknown };
    vi.spyOn(db, 'transaction').mockImplementation(((fn: () => unknown) => {
      const t = real(fn);
      const wrapped = (...a: unknown[]) => (calls.push('deferred'), t(...a));
      return Object.assign(wrapped, { immediate: () => (calls.push('immediate'), t.immediate()) });
    }) as never);
    expect(upsertEmbeddingIfCurrent(db, input)).toBe(true);
    expect(calls).toEqual(['immediate']);
    db.close();
  });

  it('succeeds while another connection holds an open read transaction', () => {
    const { db, input } = seed();
    const other = openDb(db.name);
    other.exec('BEGIN');
    other.prepare('SELECT count(*) FROM events').get();
    expect(upsertEmbeddingIfCurrent(db, input)).toBe(true);
    other.exec('COMMIT');
    other.close();
    db.close();
  });

  it('waits out a write lock held by another process instead of throwing SQLITE_BUSY', async () => {
    const { db, input } = seed();
    const script = `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.pragma('busy_timeout=5000');
      d.exec('BEGIN IMMEDIATE');console.log('ready');setTimeout(()=>{d.exec('COMMIT');d.close()},400);`;
    const child = spawn(process.execPath, ['-e', script, db.name], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res, rej) => {
      child.stdout.once('data', () => res());
      child.once('error', rej);
    });
    expect(upsertEmbeddingIfCurrent(db, input)).toBe(true);
    await new Promise((res) => child.once('exit', res));
    db.close();
  });
});

describe('forEachFilteredVector corrupt rows (Phase 6 re-review)', () => {
  it('skips a row whose BLOB length does not match dim*4 instead of throwing', () => {
    const db = openDb(tmpDbFile());
    const good = appendEvent(db, { sessionId: 's', role: 'user', content: 'Good vector.' });
    const bad = appendEvent(db, { sessionId: 's', role: 'user', content: 'Corrupt vector.' });
    const hash = (id: string) => db.prepare('SELECT content_hash FROM events WHERE id = ?').pluck().get(id) as string;
    upsertEmbedding(db, { target_kind: 'event', target_id: good.id, model: 'm', content_hash: hash(good.id), vec: vec(1, 4) });
    db.prepare(
      `INSERT INTO embeddings (target_kind, target_id, model, dim, content_hash, vec, created_at) VALUES ('event', ?, 'm', 4, ?, x'0000803f00', '2026-01-01T00:00:00Z')`,
    ).run(bad.id, hash(bad.id));
    const seen: string[] = [];
    expect(() => forEachFilteredVector(db, 'event', [], {}, (id) => seen.push(id))).not.toThrow();
    expect(seen).toEqual([good.id]);
    db.close();
  });
});

describe('countMissingOrStale (Phase 6 re-review)', () => {
  it('agrees with missingOrStale for events and claims, missing/stale/model-swapped', () => {
    const db = openDb(tmpDbFile());
    const e1 = appendEvent(db, { sessionId: 's', role: 'user', content: 'one' });
    appendEvent(db, { sessionId: 's', role: 'user', content: 'two' });
    const e3 = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' });
    expect(upsertClaims(db, { claims: [claimInput(e3.id, 'We use PostgreSQL for billing.')] }).inserted).toHaveLength(1);
    for (const kind of ['event', 'claim'] as const) {
      expect(countMissingOrStale(db, kind, 'm@a')).toBe(missingOrStale(db, kind, 100, false, 'm@a').length);
    }
    expect(countMissingOrStale(db, 'event', 'm@a')).toBe(3);
    expect(countMissingOrStale(db, 'claim')).toBe(1);
    const t = missingOrStale(db, 'event', 1, false, 'm@a')[0]!;
    upsertEmbedding(db, { target_kind: 'event', target_id: t.id, model: 'm@a', content_hash: t.content_hash, vec: vec(1, 4) });
    expect(countMissingOrStale(db, 'event', 'm@a')).toBe(2);
    expect(countMissingOrStale(db, 'event', 'm@b')).toBe(3); // different model = stale
    expect(countMissingOrStale(db, 'event')).toBe(2);
    db.close();
  });
});
