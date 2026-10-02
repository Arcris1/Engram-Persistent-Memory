import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { spoolPrompt } from '../src/cli/spool.js';
import { MIGRATIONS } from '../src/storage/schema.js';
import { openDb } from '../src/storage/db.js';
import { ROOT, runCli, tmpDbFile, tmpDir } from './helpers.js';

/** H6: a schema-v1-only DB file (no v2 tombstones table, user_version=1) built WITHOUT going through
 * openDb/migrate -- so a later openDb() call against it has a pending migration to run. */
function createV1Db(dbFile: string): void {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(MIGRATIONS[0]!);
  db.pragma('user_version = 1');
  db.close();
}

const FIXTURE = path.join(ROOT, 'test/fixtures/transcript.jsonl');
const hookJson = (extra: Record<string, unknown>) =>
  JSON.stringify({ session_id: 'sess-1', cwd: ROOT, transcript_path: '/dev/null', hook_event_name: 'UserPromptSubmit', ...extra });

function events(dbFile: string) {
  const db = openDb(dbFile);
  const rows = db.prepare('SELECT role, content, project, flags FROM events ORDER BY seq').all() as Array<{
    role: string; content: string; project: string | null; flags: string;
  }>;
  db.close();
  return rows;
}

describe('engram ingest-prompt', () => {
  it('appends one user event and prints nothing', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'We use pnpm in this repo' }) });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(events(dbFile)).toEqual([
      { role: 'user', content: 'We use pnpm in this repo', project: path.basename(ROOT), flags: '[]' },
    ]);
  });

  it('stores a fake sk- key as [REDACTED:api_key] (Phase 1 acceptance)', () => {
    const dbFile = tmpDbFile();
    runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx' }) });
    expect(events(dbFile)[0]!.content).toBe('key is [REDACTED:api_key]');
  });

  it('accepts user_input when prompt is absent (D11)', () => {
    const dbFile = tmpDbFile();
    runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ user_input: 'hello from user_input' }) });
    expect(events(dbFile)[0]!.content).toBe('hello from user_input');
  });

  it('keeps two identical prompts (distinct prompt events, D6)', () => {
    const dbFile = tmpDbFile();
    runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'continue' }) });
    runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'continue' }) });
    expect(events(dbFile)).toHaveLength(2);
  });

  it('exits 0 silently on malformed input, logging a redacted error', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['ingest-prompt'], { dbFile, stdin: '{"prompt": "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", oops' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
    expect(log).toContain('[ingest-prompt] Error: stdin is not valid JSON');
    expect(log).not.toContain('sk-ant-api03');
    expect(log).not.toContain('QrStUvWx');
  });

  it('exits 0 silently and quickly when the DB cannot be opened', () => {
    const r = runCli(['ingest-prompt'], { dbFile: '/dev/null/engram.db', stdin: hookJson({ prompt: 'x' }) });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(r.ms).toBeLessThan(2000);
  });

  it('spools the prompt (redacted, 0600) instead of dropping it when another process holds the write lock', () => {
    const dbFile = tmpDbFile();
    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    const r = runCli(['ingest-prompt'], {
      dbFile,
      stdin: hookJson({ prompt: 'blocked, key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx' }),
    });
    holder.exec('ROLLBACK');
    holder.close();
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(r.ms).toBeLessThan(2000);
    expect(events(dbFile)).toHaveLength(0);

    const spoolDir = path.join(path.dirname(dbFile), 'spool');
    const files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const spooled = path.join(spoolDir, files[0]!);
    expect(fs.statSync(spooled).mode & 0o777).toBe(0o600);
    expect(fs.statSync(spoolDir).mode & 0o777).toBe(0o700);
    const content = fs.readFileSync(spooled, 'utf8');
    expect(content).toContain('[REDACTED:api_key]');
    expect(content).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
  });

  it('exits 0 and logs when stdin exceeds the 4 MiB cap', () => {
    const dbFile = tmpDbFile();
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const r = runCli(['ingest-prompt'], { dbFile, stdin: huge });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
    expect(log).toContain('[ingest-prompt]');
    expect(log).toContain('stdin exceeds 4 MiB');
  });

  it('H6: spools the prompt when the write lock is held during open/migration of a v1-only DB', () => {
    const dbFile = tmpDbFile();
    createV1Db(dbFile);
    const holder = new Database(dbFile, { timeout: 5000 });
    holder.exec('BEGIN IMMEDIATE'); // migrate() needs the write lock too -- openDb() itself must now contend
    const r = runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'should be spooled, not dropped' }) });
    holder.exec('ROLLBACK');
    holder.close();

    expect(r).toMatchObject({ status: 0, stdout: '' });
    const spoolDir = path.join(path.dirname(dbFile), 'spool');
    const files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const spooled = JSON.parse(fs.readFileSync(path.join(spoolDir, files[0]!), 'utf8')) as { content: string };
    expect(spooled.content).toBe('should be spooled, not dropped');
  });

  it('exits 0 silently when ENGRAM_DB is not absolute (D22)', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['ingest-prompt'], {
      dbFile,
      stdin: hookJson({ prompt: 'x' }),
      env: { ENGRAM_DB: 'relative/e.db' },
    });
    expect(r).toMatchObject({ status: 0, stdout: '' });
  });

  it('ignores an empty prompt', () => {
    const dbFile = tmpDbFile();
    expect(runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: '  ' }) }).status).toBe(0);
    expect(events(dbFile)).toHaveLength(0);
  });
});

describe('engram ingest-transcript', () => {
  it('ingests the fixture once, even when run twice (Phase 1 acceptance)', () => {
    const dbFile = tmpDbFile();
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);
    const stdin = hookJson({ hook_event_name: 'Stop', transcript_path: transcript });
    expect(runCli(['ingest-transcript'], { dbFile, stdin })).toMatchObject({ status: 0, stdout: '' });
    expect(runCli(['ingest-transcript'], { dbFile, stdin })).toMatchObject({ status: 0, stdout: '' });
    expect(events(dbFile).map((e) => e.role)).toEqual(['assistant', 'assistant', 'assistant']);
  });

  it('honours ingestToolResults from config.json', () => {
    const dbFile = tmpDbFile();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(dbFile), 'config.json'), '{"ingestToolResults": true}');
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);
    runCli(['ingest-transcript'], { dbFile, stdin: hookJson({ transcript_path: transcript }) });
    expect(events(dbFile).map((e) => e.role)).toContain('tool');
  });

  it('a missing transcript file (ENOENT) is a silent no-op: exits 0, logs nothing', () => {
    const dbFile = tmpDbFile();
    const missing = path.join(tmpDir(), 'does-not-exist.jsonl');
    const r = runCli(['ingest-transcript'], {
      dbFile,
      stdin: hookJson({ hook_event_name: 'Stop', transcript_path: missing }),
    });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    const logFile = path.join(path.dirname(dbFile), 'hooks.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    expect(log).not.toContain('ENOENT');
    expect(log).not.toContain('ingest-transcript');
  });

  it('G2: a lock hit during ingestTranscript itself (not the empty drainSpool) logs one line, not a stack', () => {
    const dbFile = tmpDbFile();
    openDb(dbFile).close(); // schema exists; spool dir does not, so drainSpool is a true no-op (no contention)
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);

    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    const r = runCli(['ingest-transcript'], {
      dbFile,
      stdin: hookJson({ hook_event_name: 'Stop', transcript_path: transcript }),
    });
    holder.exec('ROLLBACK');
    holder.close();

    expect(r).toMatchObject({ status: 0, stdout: '' });
    const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
    const lines = log.split('\n').filter((l) => l.includes('[ingest-transcript]'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/\[ingest-transcript\] database locked; deferred$/);
    expect(log).not.toContain('SQLITE_BUSY');
  });

  it('drains a spooled prompt before ingesting the transcript', () => {
    const dbFile = tmpDbFile();
    const prevDb = process.env.ENGRAM_DB;
    process.env.ENGRAM_DB = dbFile;
    try {
      spoolPrompt({ session_id: 'sess-1', cwd: null, transcript_path: null, prompt_id: 'spooled-1', prompt: 'spooled prompt' });
    } finally {
      if (prevDb === undefined) delete process.env.ENGRAM_DB;
      else process.env.ENGRAM_DB = prevDb;
    }

    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);
    const stdin = hookJson({ hook_event_name: 'Stop', transcript_path: transcript });
    const r = runCli(['ingest-transcript'], { dbFile, stdin });
    expect(r).toMatchObject({ status: 0, stdout: '' });

    const rows = events(dbFile);
    expect(rows).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'spooled prompt' }),
    );
    const spoolDirPath = path.join(path.dirname(dbFile), 'spool');
    expect(fs.readdirSync(spoolDirPath).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});
