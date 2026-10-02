import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db.js';
import { migrate, SCHEMA_VERSION } from '../src/storage/schema.js';
import { appendEvent } from '../src/events/events.js';
import { tmpDbFile } from './helpers.js';

describe('migrate: rollback re-upgrade (V2 must be safely re-runnable)', () => {
  it('a v2 DB rolled back to user_version=1 re-migrates to v2 without error, data intact', () => {
    const file = tmpDbFile();
    const db = openDb(file); // migrates fresh DB straight to SCHEMA_VERSION (currently 2)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Survives the rollback dance.' }).id;
    db.prepare(
      `INSERT INTO tombstones (session_id, source_ref, content_hash, created_at) VALUES ('s', 'r1', 'deadbeef', '2026-01-01T00:00:00.000Z')`,
    ).run();

    // Reviewer repro: set the live file back to v1 (the documented v2->v1 rollback knob from the
    // README) and reopen it -- migrate() must re-run the V2 migration (CREATE TABLE tombstones) a
    // second time against a database that already has the table, without throwing.
    db.pragma('user_version = 1');
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    // Data survives the round trip untouched.
    const ev2 = db.prepare(`SELECT id FROM events WHERE id = ?`).pluck().get(ev);
    expect(ev2).toBe(ev);
    const tombstoneCount = db.prepare(`SELECT count(*) FROM tombstones`).pluck().get();
    expect(tombstoneCount).toBe(1);
    db.close();
  });

  it('openDb itself (not just migrate()) re-migrates a rolled-back v2 DB without error', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'Still here after reopen.' });
    db.pragma('user_version = 1');
    db.close();

    expect(() => {
      const reopened = openDb(file);
      expect(reopened.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      reopened.close();
    }).not.toThrow();
  });
});

describe('migrate: v3 embeddings table (Phase 6 Task 2)', () => {
  it('a populated v2 DB migrates to v3 with its data intact and the embeddings table present', () => {
    const file = tmpDbFile();
    const db = openDb(file); // migrates fresh straight to SCHEMA_VERSION (currently 3)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);

    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'Predates the v3 upgrade.' }).id;

    // Simulate the real world: a database that had only ever reached v2 (tombstones, no embeddings).
    db.pragma('user_version = 2');
    db.prepare(`DROP TABLE IF EXISTS embeddings`).run();

    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const tableExists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'`)
      .pluck()
      .get();
    expect(tableExists).toBe(1);

    // Pre-existing data survived the migration untouched.
    const ev2 = db.prepare(`SELECT id FROM events WHERE id = ?`).pluck().get(ev);
    expect(ev2).toBe(ev);
    db.close();
  });

  it('re-running the v3 migration after user_version is set back to 2 is idempotent (IF NOT EXISTS)', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    db.prepare(
      `INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at)
       VALUES ('event', 'e1', 'fake', 'deadbeef', 4, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(Buffer.alloc(16));

    db.pragma('user_version = 2');
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    // The pre-existing embeddings row (and table) survived the re-run untouched.
    const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(1);
    db.close();
  });
});
