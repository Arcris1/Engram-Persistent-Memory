import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { PROFILE_FOOTER, PROFILE_HEADER } from '../src/claims/profile.js';
import { spoolPrompt } from '../src/cli/spool.js';
import { appendEvent } from '../src/events/events.js';
import { ensureSession, getSession } from '../src/events/sessions.js';
import { DATA_PREAMBLE } from '../src/mcp/wrap.js';
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
  JSON.stringify({ session_id: 'sess-1', cwd: ROOT, transcript_path: '/dev/null', hook_event_name: 'SessionStart', ...extra });

function seedFactClaim(dbFile: string): void {
  const db = openDb(dbFile);
  const eventId = appendEvent(db, { sessionId: 'seed', role: 'user', content: 'We use pnpm in this repo' }).id;
  const result = upsertClaims(db, {
    claims: [
      {
        subject: 'repo',
        predicate: 'uses_package_manager',
        object: 'pnpm',
        statement: 'This repo uses pnpm.',
        scope: 'fact',
        confidence: 0.9,
        project: null,
        sources: [{ event_id: eventId, excerpt: 'use pnpm in this repo' }],
      },
    ],
  });
  if (result.rejected.length > 0) throw new Error(`seedFactClaim rejected: ${result.rejected[0]!.reason}`);
  db.close();
}

describe('engram session-start', () => {
  it('prints the exact framed profile block for seeded claims', () => {
    const dbFile = tmpDbFile();
    seedFactClaim(dbFile);
    const r = runCli(['session-start'], { dbFile, stdin: hookJson({ source: 'startup' }) });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(PROFILE_HEADER);
    expect(lines[1]).toBe(DATA_PREAMBLE);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(PROFILE_FOOTER);
    expect(r.stdout).toContain('This repo uses pnpm.');
    expect(r.ms).toBeLessThan(1500);
  });

  it('prints nothing when there are no claims', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['session-start'], { dbFile, stdin: hookJson({}) });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(r.ms).toBeLessThan(1500);
  });

  it('prints nothing when the DB cannot be opened', () => {
    const r = runCli(['session-start'], { dbFile: '/dev/null/engram.db', stdin: hookJson({}) });
    expect(r).toMatchObject({ status: 0, stdout: '' });
  });

  it('still prints the profile when the DB is write-locked (G1: profile read happens before bookkeeping)', () => {
    const dbFile = tmpDbFile();
    seedFactClaim(dbFile);
    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    const r = runCli(['session-start'], { dbFile, stdin: hookJson({}) });
    holder.exec('ROLLBACK');
    holder.close();
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(PROFILE_HEADER);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(PROFILE_FOOTER);
    expect(r.stdout).toContain('This repo uses pnpm.');
    expect(r.ms).toBeLessThan(1500);
  });

  it('H6: openDb lock during migration of a v1-only DB -> silent empty stdout, one hooks.log line', () => {
    const dbFile = tmpDbFile();
    createV1Db(dbFile);
    const holder = new Database(dbFile, { timeout: 5000 });
    holder.exec('BEGIN IMMEDIATE'); // migrate() needs the write lock too -- openDb() itself must now contend
    const r = runCli(['session-start'], { dbFile, stdin: hookJson({}) });
    holder.exec('ROLLBACK');
    holder.close();

    expect(r).toMatchObject({ status: 0, stdout: '' });
    const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
    const lines = log.trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[session-start\] database locked; deferred$/);
  });

  it('prints nothing on malformed stdin', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['session-start'], { dbFile, stdin: '{not json' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
  });
});

describe('engram session-end', () => {
  it('sets ended_at and ingests the transcript, printing nothing', () => {
    const dbFile = tmpDbFile();
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);
    const r = runCli(['session-end'], {
      dbFile,
      stdin: hookJson({ hook_event_name: 'SessionEnd', reason: 'other', transcript_path: transcript }),
    });
    expect(r).toMatchObject({ status: 0, stdout: '' });

    const db = openDb(dbFile);
    const session = getSession(db, 'sess-1');
    const events = db.prepare('SELECT role FROM events').all();
    db.close();
    expect(session?.ended_at).not.toBeNull();
    expect(events).toHaveLength(3);
  });

  it('a missing transcript file (ENOENT) is a silent no-op: still ends the session, logs nothing', () => {
    const dbFile = tmpDbFile();
    const missing = path.join(tmpDir(), 'does-not-exist.jsonl');
    const r = runCli(['session-end'], {
      dbFile,
      stdin: hookJson({ hook_event_name: 'SessionEnd', reason: 'other', transcript_path: missing }),
    });
    expect(r).toMatchObject({ status: 0, stdout: '' });

    const db = openDb(dbFile);
    const session = getSession(db, 'sess-1');
    db.close();
    expect(session?.ended_at).not.toBeNull();

    const logFile = path.join(path.dirname(dbFile), 'hooks.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    expect(log).not.toContain('ENOENT');
    expect(log).not.toContain('session-end');
  });

  it('G2: a spool backlog under a held lock leaves ended_at unchanged and the spool file in place', () => {
    const dbFile = tmpDbFile();
    const prevDb = process.env.ENGRAM_DB;
    process.env.ENGRAM_DB = dbFile;
    try {
      spoolPrompt({ session_id: 'sess-1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'backlog' });
    } finally {
      if (prevDb === undefined) delete process.env.ENGRAM_DB;
      else process.env.ENGRAM_DB = prevDb;
    }
    // A pre-existing session row that must stay unended while the lock is held.
    const seedDb = openDb(dbFile);
    ensureSession(seedDb, { id: 'sess-1', project: null });
    seedDb.close();

    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    const r = runCli(['session-end'], {
      dbFile,
      stdin: hookJson({ hook_event_name: 'SessionEnd', reason: 'other', transcript_path: '/dev/null' }),
    });
    holder.exec('ROLLBACK');
    holder.close();

    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(r.ms).toBeLessThan(1500);

    const spoolDirPath = path.join(path.dirname(dbFile), 'spool');
    expect(fs.readdirSync(spoolDirPath).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    const db = openDb(dbFile);
    const session = getSession(db, 'sess-1');
    db.close();
    expect(session?.ended_at).toBeNull();
  });
});

describe('spool drain integration', () => {
  it('a prompt spooled under a write lock is drained into events by the next session-start', () => {
    const dbFile = tmpDbFile();
    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    runCli(['ingest-prompt'], {
      dbFile,
      stdin: JSON.stringify({
        session_id: 'sess-1',
        cwd: ROOT,
        transcript_path: '/dev/null',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'use key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
      }),
    });
    holder.exec('ROLLBACK');
    holder.close();

    const spoolDir = path.join(path.dirname(dbFile), 'spool');
    expect(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    runCli(['session-start'], { dbFile, stdin: hookJson({}) });

    const db = openDb(dbFile);
    const events = db.prepare('SELECT content FROM events').all() as Array<{ content: string }>;
    db.close();
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toContain('[REDACTED:api_key]');
    expect(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});
