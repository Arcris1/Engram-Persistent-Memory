import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaim, upsertClaims, type ClaimInput } from '../src/claims/claims.js';
import { eraseMatchingSpoolFiles, spoolDir, spoolPrompt } from '../src/cli/spool.js';
import { forget } from '../src/control/forget.js';
import { pin } from '../src/control/marks.js';
import { upsertEmbedding } from '../src/embed/store.js';
import { appendEvent, readEvent } from '../src/events/events.js';
import { openDb, type Db } from '../src/storage/db.js';
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

describe('forget', () => {
  it('throws for an unknown id', () => {
    const db = openDb(tmpDbFile());
    expect(() => forget(db, 'nope', { confirm: false })).toThrow(/no claim or event with id nope/);
    expect(() => forget(db, 'nope', { confirm: true })).toThrow(/no claim or event with id nope/);
    db.close();
  });

  it('deletes an event and the claim whose only source was that event', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, {
      sessionId: 's', role: 'user', content: 'We decided to use PostgreSQL for billing.',
    }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    const r = forget(db, ev, { confirm: true });
    expect(r.deleted).toEqual({ events: 1, claims: 1, marks_deleted: 0 });
    expect(r.rebuilt).toBe(true);
    expect(r.optimized).toBe(true);
    expect(r.plan).toEqual({
      target: { kind: 'event', id: ev },
      events: [ev],
      claims: [claimId],
      marks_added: [],
      surviving_claims: [],
      same_content_events: [],
      source_events: [],
    });
    expect(readEvent(db, ev)).toBeUndefined();
    expect(readClaim(db, claimId)).toBeUndefined();
    db.close();
  });

  it('a multi-source claim survives, losing only the forgotten event as a source', () => {
    const db = openDb(tmpDbFile());
    const evA = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const evB = appendEvent(db, {
      sessionId: 's', role: 'user', content: 'Confirmed: PostgreSQL for billing.',
    }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(evA, 'PostgreSQL for billing')] }).inserted[0]!;
    const merged = upsertClaims(db, { claims: [claimInput(evB, 'Confirmed: PostgreSQL for billing')] });
    expect(merged.merged).toEqual([claimId]); // sanity: both sources land on the same claim

    const r = forget(db, evA, { confirm: true });
    expect(r.deleted).toEqual({ events: 1, claims: 0, marks_deleted: 0 });
    expect(readClaim(db, claimId)).toBeDefined();
    const sources = db.prepare('SELECT event_id FROM claim_sources WHERE claim_id = ?').pluck().all(claimId);
    expect(sources).toEqual([evB]);
    // H5: the plan honestly lists this claim as surviving (it kept evB as a source) rather than
    // pretending forgetting evA had no effect on it at all.
    expect(r.plan.surviving_claims).toEqual([claimId]);
    db.close();
  });

  it('H5: same_content_events lists other events sharing the forgotten event\'s exact content', () => {
    const db = openDb(tmpDbFile());
    const canary = 'The exact same wording, word for word, duplicated elsewhere.';
    const evA = appendEvent(db, { sessionId: 's', role: 'user', content: canary, sourceRef: 'line-1' }).id;
    const evB = appendEvent(db, { sessionId: 's', role: 'user', content: canary, sourceRef: 'line-2' }).id;

    const r = forget(db, evA, { confirm: true });
    expect(r.plan.same_content_events).toEqual([evB]);
    expect(readEvent(db, evB)).toBeDefined(); // the duplicate itself is untouched
    db.close();
  });

  it('H5: surviving_claims and same_content_events are both empty for a claim-kind forget', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    const r = forget(db, claimId, { confirm: true });
    expect(r.plan.surviving_claims).toEqual([]);
    expect(r.plan.same_content_events).toEqual([]);
    db.close();
  });

  it('forgetting a claim adds a never_inject hash mark and blocks a future claim citing its source event', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const hash = readEvent(db, ev)!.content_hash;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    const r = forget(db, claimId, { confirm: true });
    expect(r.deleted).toEqual({ events: 0, claims: 1, marks_deleted: 0 });
    expect(r.plan).toEqual({
      target: { kind: 'claim', id: claimId },
      events: [],
      claims: [claimId],
      marks_added: [`hash:${hash}`],
      surviving_claims: [],
      same_content_events: [],
      source_events: [ev],
    });
    expect(readClaim(db, claimId)).toBeUndefined();
    expect(readEvent(db, ev)).toBeDefined(); // the source event itself is not deleted

    const mark = db.prepare(`SELECT kind FROM marks WHERE target_id = ?`).get(`hash:${hash}`);
    expect(mark).toEqual({ kind: 'never_inject' });

    const again = upsertClaims(db, {
      claims: [
        claimInput(ev, 'use PostgreSQL for billing', { object: 'MySQL', statement: 'Billing uses MySQL.' }),
      ],
    });
    expect(again.rejected).toEqual([{ index: 0, reason: `event ${ev} was forgotten` }]);
    expect(again.inserted).toEqual([]);
    db.close();
  });

  it('nulls a superseded pointer when the superseding claim is forgotten', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const a = upsertClaims(db, {
      claims: [claimInput(ev, 'use PostgreSQL for billing', { valid_from: '2026-01-01' })],
    }).inserted[0]!;
    const b = upsertClaims(db, {
      claims: [
        claimInput(ev, 'use PostgreSQL for billing', {
          object: 'MySQL', statement: 'Billing moved to MySQL.', supersedes: a, valid_from: '2026-09-01',
        }),
      ],
    }).inserted[0]!;
    expect(readClaim(db, a)!.superseded_by).toBe(b);

    forget(db, b, { confirm: true });
    expect(readClaim(db, a)!.superseded_by).toBeNull();
    db.close();
  });

  it('preview computes the same plan and counts as confirm, and makes no changes', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    const preview = forget(db, ev, { confirm: false });
    expect(preview.deleted).toEqual({ events: 1, claims: 1, marks_deleted: 0 });
    expect(preview.rebuilt).toBe(false);
    expect(readEvent(db, ev)).toBeDefined();
    expect(readClaim(db, claimId)).toBeDefined();
    expect(db.prepare('SELECT count(*) FROM events').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM claims').pluck().get()).toBe(1);

    const confirmed = forget(db, ev, { confirm: true });
    expect(confirmed.deleted).toEqual(preview.deleted);
    expect(confirmed.plan).toEqual(preview.plan);
    expect(confirmed.rebuilt).toBe(true);
    expect(readEvent(db, ev)).toBeUndefined();
    db.close();
  });

  it('preview of a claim forget does not add the hash mark or block future citing claims', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const hash = readEvent(db, ev)!.content_hash;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    forget(db, claimId, { confirm: false });
    expect(db.prepare(`SELECT 1 FROM marks WHERE target_id = ?`).get(`hash:${hash}`)).toBeUndefined();
    expect(readClaim(db, claimId)).toBeDefined();
    db.close();
  });

  it('deletes accesses rows targeting the forgotten event and its orphaned claims', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    db.prepare(
      `INSERT INTO accesses (id, ts, target_id, query, used) VALUES ('a1', '2026-01-01T00:00:00.000Z', ?, 'q', 0)`,
    ).run(ev);
    db.prepare(
      `INSERT INTO accesses (id, ts, target_id, query, used) VALUES ('a2', '2026-01-01T00:00:00.000Z', ?, 'q', 0)`,
    ).run(claimId);

    forget(db, ev, { confirm: true });
    expect(db.prepare('SELECT count(*) FROM accesses').pluck().get()).toBe(0);
    db.close();
  });

  it('prevents a forgotten event from being resurrected by a transcript rescan (D32 tombstone)', () => {
    const db = openDb(tmpDbFile());
    const r1 = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-1' });
    forget(db, r1.id, { confirm: true });

    const r2 = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-1' });
    expect(r2).toEqual({ id: '', inserted: false, tombstoned: true });
    expect(db.prepare('SELECT count(*) FROM events').pluck().get()).toBe(0);
    db.close();
  });

  it('a memory_record-style event (no source_ref) is also tombstoned by content hash', () => {
    const db = openDb(tmpDbFile());
    const r1 = appendEvent(db, { sessionId: 'mcp-01X', role: 'user', content: 'Remember: port 5433.' });
    forget(db, r1.id, { confirm: true });

    const r2 = appendEvent(db, { sessionId: 'mcp-01X', role: 'user', content: 'Remember: port 5433.' });
    expect(r2).toEqual({ id: '', inserted: false, tombstoned: true });
    db.close();
  });

  it('H2: forgetting a pinned claim with a note deletes its mark row too', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    pin(db, claimId, 'keep this one');
    expect(db.prepare(`SELECT 1 FROM marks WHERE target_id = ?`).get(claimId)).toBeDefined();

    const r = forget(db, claimId, { confirm: true });
    expect(r.deleted.marks_deleted).toBe(1);
    expect(db.prepare(`SELECT 1 FROM marks WHERE target_id = ?`).get(claimId)).toBeUndefined();
    db.close();
  });

  it('H2: an event-cascade orphan claim with a pin loses its mark too', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    pin(db, claimId, 'keep this one');
    expect(db.prepare(`SELECT 1 FROM marks WHERE target_id = ?`).get(claimId)).toBeDefined();

    const r = forget(db, ev, { confirm: true }); // event-forget cascades to delete the orphan claimId
    expect(readClaim(db, claimId)).toBeUndefined();
    expect(r.deleted.marks_deleted).toBe(1);
    expect(db.prepare(`SELECT 1 FROM marks WHERE target_id = ?`).get(claimId)).toBeUndefined();
    db.close();
  });

  it('Task 0: claim-kind forget plan lists its source events, event-kind forget never does', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;

    const claimPreview = forget(db, claimId, { confirm: false });
    expect(claimPreview.plan.source_events).toEqual([ev]);

    const ev2 = appendEvent(db, { sessionId: 's', role: 'user', content: 'Standalone note with no claim.' }).id;
    const eventPreview = forget(db, ev2, { confirm: false });
    expect(eventPreview.plan.source_events).toEqual([]);
    db.close();
  });

  it('H2: preview (confirm=false) does not delete marks, but still counts them', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    pin(db, claimId, 'keep this one');

    const preview = forget(db, claimId, { confirm: false });
    expect(preview.deleted.marks_deleted).toBe(1);
    expect(db.prepare(`SELECT 1 FROM marks WHERE target_id = ?`).get(claimId)).toBeDefined();
    db.close();
  });
});

/**
 * H7: the canary must be lowercase and stem-stable -- events_fts uses the porter tokenizer, which
 * lowercases and suffix-strips every term it indexes. A mixed-case canary (e.g. the old
 * 'CANARYFORGETERASE9f3c7a1b2d') is never what actually lands in the FTS segment b-tree in the first
 * place, so a test that only looks for the original mixed-case string can pass even if `optimize`
 * were silently broken or removed -- it was only ever exercising secure_delete on the `events` table's
 * own row, never the FTS leftovers that `optimize` exists to clean up (D31). 'zqxjkvmarker' is
 * lowercase already and has no common English inflectional suffix for Porter to strip, so the indexed
 * term is byte-identical to the canary itself.
 */
const STEM_STABLE_CANARY = 'zqxjkvmarker';

/** 100 filler events around the canary, same as the reviewer's probe3.mjs reproduction, so the canary
 * isn't trivially the only content in the database (and so a checkpoint has real pages to rewrite). */
function seedWithCanary(db: Db, canary: string): string {
  for (let i = 0; i < 50; i++) {
    appendEvent(db, { sessionId: 's', role: 'user', content: `filler number ${i} alpha beta`, sourceRef: `f${i}` });
  }
  const ev = appendEvent(db, { sessionId: 's', role: 'user', content: `secret token ${canary} here`, sourceRef: 'c' }).id;
  for (let i = 50; i < 100; i++) {
    appendEvent(db, { sessionId: 's', role: 'user', content: `filler number ${i} gamma`, sourceRef: `f${i}` });
  }
  return ev;
}

describe('forget: physical erasure', () => {
  it('removes the stem-stable canary token from the db, wal and shm files after confirm (secure_delete + optimize + checkpoint)', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    const ev = seedWithCanary(db, STEM_STABLE_CANARY);
    db.pragma('wal_checkpoint(TRUNCATE)'); // land everything in the main db file before forgetting

    const r = forget(db, ev, { confirm: true });
    expect(r.rebuilt).toBe(true);
    db.close();

    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${file}${suffix}`;
      if (!fs.existsSync(target)) continue;
      const bytes = fs.readFileSync(target);
      expect(bytes.includes(STEM_STABLE_CANARY)).toBe(false);
    }
  });

  it('control: a plain DELETE without FTS optimize still leaves the canary in raw bytes (proves the test above can actually fail)', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    const ev = seedWithCanary(db, STEM_STABLE_CANARY);
    db.pragma('wal_checkpoint(TRUNCATE)');

    // secure_delete zeroes the events row itself and the events_fts_ad trigger fires (recording a
    // tombstone in the FTS shadow tables), but without `optimize` the FTS segment b-tree leaf that
    // already held the indexed term is never rewritten -- its bytes are untouched.
    db.prepare(`DELETE FROM events WHERE id = ?`).run(ev);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    const bytes = fs.readFileSync(file);
    expect(bytes.includes(STEM_STABLE_CANARY)).toBe(true);
  });
});

/**
 * D42/Phase 6 Task 2: a distinctive vector pattern -- every component the same unusual value -- rather
 * than a fake-embedder-derived vector, so the test can scan raw bytes for an exact, deterministic
 * little-endian Float32 run without depending on the fake embedder's hashing scheme. 384 floats
 * (matching the real model's dim) makes for a long, vanishingly-unlikely-to-occur-by-chance byte run.
 */
function distinctiveVector(): Float32Array {
  return new Float32Array(384).fill(0.918273645);
}

function vectorBytes(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

describe('forget: embeddings erasure (D42/Phase 6 Task 2)', () => {
  it('deletes the embeddings row for a forgotten event, in the same transaction', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Has a vector.' }).id;
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: 'h', vec: distinctiveVector() });
    expect(db.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(1);

    forget(db, ev, { confirm: true });
    expect(db.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(0);
    db.close();
  });

  it('deletes the embeddings row for a forgotten claim', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    upsertEmbedding(db, { target_kind: 'claim', target_id: claimId, model: 'fake', content_hash: 'h', vec: distinctiveVector() });
    expect(db.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(1);

    forget(db, claimId, { confirm: true });
    expect(db.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(0);
    db.close();
  });

  it('forgetting an event also deletes the embedding of a claim orphaned by the cascade', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    const claimId = upsertClaims(db, { claims: [claimInput(ev, 'use PostgreSQL for billing')] }).inserted[0]!;
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: 'h1', vec: distinctiveVector() });
    upsertEmbedding(db, { target_kind: 'claim', target_id: claimId, model: 'fake', content_hash: 'h2', vec: distinctiveVector() });

    forget(db, ev, { confirm: true });
    expect(db.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(0);
    expect(readClaim(db, claimId)).toBeUndefined();
    db.close();
  });

  it('preview (confirm=false) never deletes the embeddings row', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Has a vector.' }).id;
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: 'h', vec: distinctiveVector() });

    forget(db, ev, { confirm: false });
    expect(db.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(1);
    db.close();
  });

  it('physical erasure: the vector bytes do not survive in the db, wal or shm files after confirm', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    const ev = seedWithCanary(db, STEM_STABLE_CANARY); // some unrelated filler rows, as in the FTS canary test
    const vec = distinctiveVector();
    upsertEmbedding(db, { target_kind: 'event', target_id: ev, model: 'fake', content_hash: 'h', vec });
    db.pragma('wal_checkpoint(TRUNCATE)');

    forget(db, ev, { confirm: true });
    db.close();

    const needle = vectorBytes(vec);
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${file}${suffix}`;
      if (!fs.existsSync(target)) continue;
      const bytes = fs.readFileSync(target);
      expect(bytes.includes(needle)).toBe(false);
    }
  });
});

describe('forget: spool erasure', () => {
  let prevDb: string | undefined;

  afterEach(() => {
    if (prevDb === undefined) delete process.env.ENGRAM_DB;
    else process.env.ENGRAM_DB = prevDb;
    prevDb = undefined;
  });

  function useDb(dbFile: string): void {
    prevDb = process.env.ENGRAM_DB;
    process.env.ENGRAM_DB = dbFile;
  }

  it('eraseMatchingSpoolFiles deletes .json, .json.claimed and .json.bad files matching by content or prompt_id', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const dir = spoolDir();

    fs.writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify({ session_id: 's', cwd: null, transcript_path: null, prompt_id: 'p1', ts: 't', content: 'match me' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(dir, 'b.json.claimed'),
      JSON.stringify({ session_id: 's', cwd: null, transcript_path: null, prompt_id: 'other', ts: 't', content: 'unrelated content' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(dir, 'c.json.bad'),
      JSON.stringify({ session_id: 's', cwd: null, transcript_path: null, prompt_id: 'target-ref', ts: 't', content: 'different content' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, 'hooks.log'), 'match me -- but this is the hooks log', { mode: 0o600 });

    const erased = eraseMatchingSpoolFiles({ content: 'match me', sourceRef: 'target-ref' });
    expect(erased.sort()).toEqual(['a.json', 'c.json.bad']);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toEqual(['b.json.claimed', 'hooks.log']);
  });

  it('forget(confirm=true) deletes matching spool files for the forgotten event, leaving hooks.log alone', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const dir = spoolDir();

    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'spooled note one' });
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p2', prompt: 'unrelated other note' });
    fs.writeFileSync(path.join(dir, 'hooks.log'), 'hook activity, no memory content', { mode: 0o600 });

    const db: Db = openDb(dbFile);
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', content: 'spooled note one', sourceRef: 'p1',
    }).id;

    forget(db, ev, { confirm: true });
    db.close();

    const remaining = fs.readdirSync(dir);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain('hooks.log');
    const leftover = remaining.find((f) => f.endsWith('.json'))!;
    const rec = JSON.parse(fs.readFileSync(path.join(dir, leftover), 'utf8')) as { prompt_id: string };
    expect(rec.prompt_id).toBe('p2');
  });

  it('forget(confirm=false) does not touch spool files', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const dir = spoolDir();
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'spooled note one' });

    const db: Db = openDb(dbFile);
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', content: 'spooled note one', sourceRef: 'p1',
    }).id;

    forget(db, ev, { confirm: false });
    db.close();

    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });
});

describe('forget: H8 checkpointed flag', () => {
  it('is true for an uncontended confirmed forget, and true for a preview (nothing is checkpointed)', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    expect(forget(db, ev, { confirm: false }).checkpointed).toBe(true);
    expect(forget(db, ev, { confirm: true }).checkpointed).toBe(true);
    db.close();
  });

  it('is false when an open reader elsewhere blocks the WAL checkpoint from fully completing', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;

    // A separate connection holding an open read transaction's snapshot blocks wal_checkpoint(TRUNCATE)
    // from fully completing (reproduces the reviewer's probe2.mjs "checkpoint with open reader" case).
    const reader = new Database(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM events').get();

    const r = forget(db, ev, { confirm: true });
    expect(r.checkpointed).toBe(false);
    // The forget itself still succeeded in full -- checkpointed is about WAL housekeeping, not the delete.
    expect(r.deleted).toEqual({ events: 1, claims: 0, marks_deleted: 0 });
    expect(readEvent(db, ev)).toBeUndefined();

    reader.exec('COMMIT');
    reader.close();
    db.close();
  });
});

describe('forget: Task 0 optimized flag', () => {
  it('is true for an uncontended confirmed forget, and true for a preview (nothing is optimized)', () => {
    const db = openDb(tmpDbFile());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;
    expect(forget(db, ev, { confirm: false }).optimized).toBe(true);
    expect(forget(db, ev, { confirm: true }).optimized).toBe(true);
    db.close();
  });

  it('is false when the claims_fts optimize statement fails after the delete transaction commits', () => {
    const db = openDb(tmpDbFile());
    // Forgetting this event never touches the claims table (no claim derived from it), so dropping
    // claims_fts ahead of time doesn't interfere with the main delete transaction's own triggers --
    // only the post-commit `INSERT INTO claims_fts(claims_fts) VALUES('optimize')` call sees it gone.
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Standalone note with no claim.' }).id;
    db.exec('DROP TABLE claims_fts');

    const r = forget(db, ev, { confirm: true });
    expect(r.optimized).toBe(false);
    // The forget itself still succeeded in full -- optimized is about FTS housekeeping, not the delete.
    expect(r.deleted).toEqual({ events: 1, claims: 0, marks_deleted: 0 });
    expect(readEvent(db, ev)).toBeUndefined();
    db.close();
  });
});
