import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSession } from '../src/events/sessions.js';
import { ingestTranscript, parseTranscriptLines } from '../src/events/transcript.js';
import { openDb } from '../src/storage/db.js';
import { ROOT, tmpDbFile, tmpDir } from './helpers.js';

const FIXTURE = path.join(ROOT, 'test/fixtures/transcript.jsonl');
const fixture = () => fs.readFileSync(FIXTURE, 'utf8');
const count = (db: ReturnType<typeof openDb>) => db.prepare('SELECT count(*) FROM events').pluck().get();

function copyFixture(): string {
  const file = path.join(tmpDir(), 'session.jsonl');
  fs.writeFileSync(file, fixture());
  return file;
}

describe('parseTranscriptLines', () => {
  it('keeps assistant text only, skipping thinking, tool_use, sidechains and junk', () => {
    const items = parseTranscriptLines(fixture(), { ingestToolResults: false });
    expect(items.map((i) => i.uuid)).toEqual(['a2', 'a5', 'a6']);
    expect(items[0]).toMatchObject({ role: 'assistant', kind: 'message', ts: '2026-09-20T10:00:06.000Z' });
    expect(items[0]!.text).toContain('PostgreSQL');
  });

  it('adds tool results when enabled', () => {
    const items = parseTranscriptLines(fixture(), { ingestToolResults: true });
    expect(items.find((i) => i.uuid === 'u2')).toMatchObject({ role: 'tool', kind: 'tool_result', text: 'README.md\npackage.json' });
  });
});

describe('ingestTranscript', () => {
  it('is idempotent: ingesting twice leaves the count unchanged (Phase 1 acceptance)', () => {
    const db = openDb(tmpDbFile());
    const file = copyFixture();
    const first = ingestTranscript(db, { sessionId: 'sess-fixture', transcriptPath: file, project: 'billing' });
    expect(first).toEqual({ inserted: 3, duplicates: 0, offset: fs.statSync(file).size });
    const second = ingestTranscript(db, { sessionId: 'sess-fixture', transcriptPath: file, project: 'billing' });
    expect(second.inserted).toBe(0);
    expect(count(db)).toBe(3);
    db.close();
  });

  it('never consumes a trailing partial line, and picks it up once complete', () => {
    const db = openDb(tmpDbFile());
    const file = copyFixture();
    const full = fs.statSync(file).size;
    const line = '{"type":"assistant","uuid":"a7","timestamp":"2026-09-20T10:03:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Late line"}]}}';
    fs.appendFileSync(file, line.slice(0, 40));
    expect(ingestTranscript(db, { sessionId: 's', transcriptPath: file })).toMatchObject({ inserted: 3, offset: full });
    fs.appendFileSync(file, `${line.slice(40)}\n`);
    expect(ingestTranscript(db, { sessionId: 's', transcriptPath: file }).inserted).toBe(1);
    expect(count(db)).toBe(4);
    db.close();
  });

  it('restarts from 0 without duplicates when the file shrinks', () => {
    const db = openDb(tmpDbFile());
    const file = copyFixture();
    ingestTranscript(db, { sessionId: 's', transcriptPath: file });
    fs.writeFileSync(file, fixture().split('\n').slice(0, 4).join('\n') + '\n');
    const r = ingestTranscript(db, { sessionId: 's', transcriptPath: file });
    expect(r.inserted).toBe(0);
    expect(r.offset).toBe(fs.statSync(file).size);
    expect(getSession(db, 's')!.ingest_offset).toBe(fs.statSync(file).size);
    expect(count(db)).toBe(3);
    db.close();
  });

  it('rescans from 0 when the file is replaced by different, larger content (no line is lost, D27)', () => {
    const db = openDb(tmpDbFile());
    const file = path.join(tmpDir(), 'replaced.jsonl');
    const entry = (uuid: string, text: string) =>
      `{"type":"assistant","uuid":"${uuid}","timestamp":"2026-09-20T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}\n`;

    fs.writeFileSync(file, entry('x1', 'one') + entry('x2', 'two'));
    const first = ingestTranscript(db, { sessionId: 's', transcriptPath: file });
    expect(first.inserted).toBe(2);
    const offset = first.offset;

    // A different, larger file whose first entry's text alone is longer than the old offset, so
    // the old offset lands strictly inside that entry's JSON, not at a line boundary. A naive read
    // from the stale offset would start mid-object and lose this entire first entry.
    const replacement = entry('y1', 'A'.repeat(offset + 50)) + entry('y2', 'short');
    fs.writeFileSync(file, replacement);
    expect(replacement.length).toBeGreaterThan(offset);
    expect(replacement[offset - 1]).not.toBe('\n');

    const second = ingestTranscript(db, { sessionId: 's', transcriptPath: file });
    expect(second.inserted).toBe(2);
    expect(count(db)).toBe(4);
    db.close();
  });

  it('throws when the transcript does not exist', () => {
    const db = openDb(tmpDbFile());
    expect(() => ingestTranscript(db, { sessionId: 's', transcriptPath: '/nonexistent/x.jsonl' })).toThrow(/ENOENT/);
    db.close();
  });
});
