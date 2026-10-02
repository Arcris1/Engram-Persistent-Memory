import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/storage/db.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/storage/schema.js';
import { tmpDbFile, tmpDir } from './helpers.js';

function insertEvent(db: Db, id: string, content: string): void {
  db.prepare(
    `INSERT INTO events (id, ts, session_id, role, content, content_hash)
     VALUES (?, '2026-01-01T00:00:00.000Z', 's', 'user', ?, ?)`,
  ).run(id, content, `h-${id}`);
}

const ftsCount = (db: Db, q: string) =>
  db.prepare(`SELECT count(*) FROM events_fts WHERE events_fts MATCH ?`).pluck().get(q) as number;

describe('openDb', () => {
  it('creates the directory 0700 and db + wal 0600, in WAL mode', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    insertEvent(db, 'e1', 'hello');
    expect(fs.statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    db.close();
  });

  it('does not chmod a pre-existing directory (D9)', () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o755);
    openDb(path.join(dir, 'x.db')).close();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('creates every §4 table and index', () => {
    const db = openDb(tmpDbFile());
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all();
    for (const t of ['events', 'sessions', 'claims', 'claim_sources', 'marks', 'accesses', 'events_fts', 'claims_fts']) {
      expect(tables).toContain(t);
    }
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent across reopen', () => {
    const file = tmpDbFile();
    openDb(file).close();
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('refuses a database written by a newer engram', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDb(file)).toThrow(/newer engram/);
  });

  it('keeps events append-only (D7)', () => {
    const db = openDb(tmpDbFile());
    insertEvent(db, 'e1', 'hello');
    expect(() => db.prepare(`UPDATE events SET content = 'x' WHERE id = 'e1'`).run()).toThrow(/append-only/);
    db.close();
  });

  it('keeps events_fts in sync on insert and delete', () => {
    const db = openDb(tmpDbFile());
    insertEvent(db, 'e1', 'the quick brown fox');
    expect(ftsCount(db, 'fox')).toBe(1);
    db.prepare(`DELETE FROM events WHERE id = 'e1'`).run();
    expect(ftsCount(db, 'fox')).toBe(0);
    db.close();
  });

  it('keeps FTS rowids valid across VACUUM (D5)', () => {
    const db = openDb(tmpDbFile());
    insertEvent(db, 'e1', 'alpha one');
    insertEvent(db, 'e2', 'beta two');
    insertEvent(db, 'e3', 'gamma three');
    db.prepare(`DELETE FROM events WHERE id = 'e1'`).run();
    db.exec('VACUUM');
    const hit = db
      .prepare(`SELECT e.id FROM events_fts JOIN events e ON e.seq = events_fts.rowid WHERE events_fts MATCH 'gamma'`)
      .pluck()
      .get();
    expect(hit).toBe('e3');
    db.close();
  });

  it('nulls superseded_by when the superseding claim is deleted (D19/D20)', () => {
    const db = openDb(tmpDbFile());
    db.prepare(
      `INSERT INTO claims (id, subject, predicate, object, statement, confidence, recorded_at)
       VALUES ('old', 'user', 'prefers', 'tabs', 'The user prefers tabs', 0.9, '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO claims (id, subject, predicate, object, statement, confidence, recorded_at)
       VALUES ('new', 'user', 'prefers', 'spaces', 'The user prefers spaces', 0.9, '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(`UPDATE claims SET superseded_by = 'new' WHERE id = 'old'`).run();
    db.prepare(`DELETE FROM claims WHERE id = 'new'`).run();
    const row = db.prepare(`SELECT superseded_by FROM claims WHERE id = 'old'`).get() as {
      superseded_by: string | null;
    };
    expect(row.superseded_by).toBeNull();
    db.close();
  });

  it('marks: same target can hold both pinned and never_inject, but not a duplicate pinned (D19/D20)', () => {
    const db = openDb(tmpDbFile());
    const insert = db.prepare(`INSERT INTO marks (target_id, kind, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`);
    insert.run('x', 'pinned');
    insert.run('x', 'never_inject');
    const count = db.prepare(`SELECT count(*) FROM marks WHERE target_id = 'x'`).pluck().get() as number;
    expect(count).toBe(2);
    expect(() => insert.run('x', 'pinned')).toThrow();
    db.close();
  });

  it('indexes claim_sources by event_id (D19/D20)', () => {
    const db = openDb(tmpDbFile());
    const indexes = db.prepare(`PRAGMA index_list('claim_sources')`).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('claim_sources_event');
    db.close();
  });

  it('sets secure_delete (D31)', () => {
    const db = openDb(tmpDbFile());
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    db.close();
  });

  it('migrates a v1-only database (created by running only V1) to v2 with its data intact (D32)', () => {
    const file = tmpDbFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    raw.exec(MIGRATIONS[0]!); // V1 only -- simulates a real pre-Phase-4 database
    raw.pragma('user_version = 1');
    raw
      .prepare(
        `INSERT INTO events (id, ts, session_id, role, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('e1', '2026-01-01T00:00:00.000Z', 's1', 'user', 'pre-existing content', 'h1');
    raw.close();

    // D42/Phase 6 Task 2 bumped SCHEMA_VERSION to 3 (embeddings table) -- a v1-only database migrates
    // straight through v2 and v3 in one openDb() call, same as it always has for every version added
    // since.
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all();
    expect(tables).toContain('tombstones');
    expect(tables).toContain('embeddings');
    const row = db.prepare(`SELECT content FROM events WHERE id = 'e1'`).get() as { content: string };
    expect(row.content).toBe('pre-existing content');
    db.close();
  });

  it('keeps claims_fts in sync on insert and update', () => {
    const db = openDb(tmpDbFile());
    db.prepare(
      `INSERT INTO claims (id, subject, predicate, object, statement, confidence, recorded_at)
       VALUES ('c1', 'user', 'prefers', 'tabs', 'The user prefers tabs', 0.9, '2026-01-01T00:00:00.000Z')`,
    ).run();
    const q = (term: string) =>
      db.prepare(`SELECT count(*) FROM claims_fts WHERE claims_fts MATCH ?`).pluck().get(term) as number;
    expect(q('tabs')).toBe(1);
    db.prepare(`UPDATE claims SET statement = 'The user prefers spaces', object = 'spaces' WHERE id = 'c1'`).run();
    expect(q('tabs')).toBe(0);
    expect(q('spaces')).toBe(1);
    db.close();
  });
});
