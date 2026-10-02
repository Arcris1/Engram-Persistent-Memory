import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/core/hash.js';
import { appendEvent, readEvent } from '../src/events/events.js';
import { ensureSession, getSession, setIngestOffset } from '../src/events/sessions.js';
import { openDb } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

const count = (db: ReturnType<typeof openDb>) => db.prepare('SELECT count(*) FROM events').pluck().get();

describe('appendEvent', () => {
  it('stores a processed event and creates its session', () => {
    const db = openDb(tmpDbFile());
    const r = appendEvent(db, { sessionId: 's1', role: 'user', content: 'We chose PostgreSQL', project: 'billing', ts: '2026-09-01T10:00:00Z' });
    expect(r.inserted).toBe(true);
    const e = readEvent(db, r.id)!;
    expect(e).toMatchObject({ session_id: 's1', role: 'user', kind: 'message', scope: 'fact', project: 'billing', flags: [] });
    expect(e.ts).toBe('2026-09-01T10:00:00.000Z');
    expect(e.content_hash).toBe(sha256('We chose PostgreSQL'));
    expect(getSession(db, 's1')?.project).toBe('billing');
    db.close();
  });

  it('dedupes the same source_ref + content (idempotent ingest)', () => {
    const db = openDb(tmpDbFile());
    const a = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-1' });
    const b = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-1' });
    expect(b).toEqual({ id: a.id, inserted: false });
    expect(count(db)).toBe(1);
    db.close();
  });

  it('keeps a genuinely repeated message with a different source_ref (D6)', () => {
    const db = openDb(tmpDbFile());
    appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-1' });
    appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-2' });
    expect(count(db)).toBe(2);
    db.close();
  });

  it('dedupes by source_ref alone even when content differs (D27: redaction/detection can\'t duplicate a transcript line)', () => {
    const db = openDb(tmpDbFile());
    const a = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done.', sourceRef: 'uuid-1' });
    const b = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Done, differently redacted.', sourceRef: 'uuid-1' });
    expect(b).toEqual({ id: a.id, inserted: false });
    expect(count(db)).toBe(1);
    expect(readEvent(db, a.id)!.content).toBe('Done.');
    db.close();
  });

  it('never writes the raw secret to the DB or WAL file', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    const secret = 'sk-ant-api03-ZZZZsecretZZZZsecretZZZZ';
    const r = appendEvent(db, { sessionId: 's', role: 'user', content: `use ${secret}` });
    expect(readEvent(db, r.id)!.content).toBe('use [REDACTED:api_key]');
    expect(readEvent(db, r.id)!.flags).toContain('secret_redacted');
    db.close();
    for (const f of [file, `${file}-wal`]) {
      if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(secret)).toBe(false);
    }
  });

  it('rejects empty content', () => {
    const db = openDb(tmpDbFile());
    expect(() => appendEvent(db, { sessionId: 's', role: 'user', content: '   ' })).toThrow(/empty/);
    db.close();
  });

  it('falls back to the session project when the caller omits it', () => {
    const db = openDb(tmpDbFile());
    appendEvent(db, { sessionId: 's', role: 'user', content: 'First event', project: 'billing', sourceRef: 'uuid-1' });
    const r2 = appendEvent(db, { sessionId: 's', role: 'assistant', content: 'Second event', sourceRef: 'uuid-2' });
    const e2 = readEvent(db, r2.id)!;
    expect(e2.project).toBe('billing');
    db.close();
  });
});

describe('ensureSession', () => {
  it('keeps the first known project and resets the offset when the transcript path changes', () => {
    const db = openDb(tmpDbFile());
    ensureSession(db, { id: 's', project: 'a', transcriptPath: '/t/one.jsonl' });
    setIngestOffset(db, 's', 500);
    expect(ensureSession(db, { id: 's', project: 'b', transcriptPath: '/t/one.jsonl' })).toMatchObject({ project: 'a', ingest_offset: 500 });
    expect(ensureSession(db, { id: 's', transcriptPath: '/t/two.jsonl' })).toMatchObject({ transcript_path: '/t/two.jsonl', ingest_offset: 0 });
    db.close();
  });
});
