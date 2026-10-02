import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { drainSpool, spoolDir, spoolPrompt, STALE_CLAIM_MS } from '../src/cli/spool.js';
import { appendEvent } from '../src/events/events.js';
import { openDb } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

let prevDb: string | undefined;

function useDb(dbFile: string): void {
  prevDb = process.env.ENGRAM_DB;
  process.env.ENGRAM_DB = dbFile;
}

afterEach(() => {
  if (prevDb === undefined) delete process.env.ENGRAM_DB;
  else process.env.ENGRAM_DB = prevDb;
  prevDb = undefined;
});

describe('spoolPrompt', () => {
  it('writes an already-redacted, capped record as a 0600 file in a 0700 directory', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({
      session_id: 's1',
      cwd: '/repo',
      transcript_path: null,
      prompt_id: 'p1',
      prompt: 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
    });

    const dir = spoolDir();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const full = path.join(dir, files[0]!);
    expect(fs.statSync(full).mode & 0o777).toBe(0o600);

    const record = JSON.parse(fs.readFileSync(full, 'utf8')) as { session_id: string; content: string };
    expect(record.session_id).toBe('s1');
    expect(record.content).toBe('key is [REDACTED:api_key]');
    expect(record.content).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
  });
});

describe('drainSpool', () => {
  it('G6: a drained event keeps the secret_redacted flag computed at spool-write time', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({
      session_id: 's1',
      cwd: null,
      transcript_path: null,
      prompt_id: 'p-secret',
      prompt: 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
    });
    // The flag must already be on the spool file itself, before drain ever runs.
    const [spooledFile] = fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.json'));
    const spooledRecord = JSON.parse(fs.readFileSync(path.join(spoolDir(), spooledFile!), 'utf8')) as { flags?: string[] };
    expect(spooledRecord.flags).toEqual(['secret_redacted']);

    const db = openDb(dbFile);
    drainSpool(db);
    const row = db.prepare('SELECT flags, content FROM events').get() as { flags: string; content: string };
    db.close();

    expect(JSON.parse(row.flags)).toEqual(['secret_redacted']);
    expect(row.content).toBe('key is [REDACTED:api_key]');
  });

  it('ingests a spooled prompt as a user event, keyed by prompt_id, and removes the file', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'hello there' });

    const db = openDb(dbFile);
    drainSpool(db);
    const rows = db.prepare('SELECT role, content, source_ref FROM events').all() as Array<{
      role: string;
      content: string;
      source_ref: string;
    }>;
    db.close();

    expect(rows).toEqual([{ role: 'user', content: 'hello there', source_ref: 'p1' }]);
    expect(fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('falls back to a file-derived source_ref when prompt_id is absent', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: null, prompt: 'no prompt id' });

    const db = openDb(dbFile);
    drainSpool(db);
    const row = db.prepare('SELECT source_ref FROM events').get() as { source_ref: string };
    db.close();
    expect(row.source_ref).not.toBe('');
  });

  it('drains two spooled prompts for the same session as two distinct events', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'first' });
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p2', prompt: 'second' });

    const db = openDb(dbFile);
    drainSpool(db);
    const count = db.prepare('SELECT count(*) FROM events').pluck().get();
    db.close();
    expect(count).toBe(2);
  });

  it('moves a corrupt spool file to .bad instead of retrying it forever', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const dir = spoolDir();
    fs.writeFileSync(path.join(dir, 'corrupt-entry.json'), 'not valid json', { mode: 0o600 });

    const db = openDb(dbFile);
    drainSpool(db);
    db.close();

    expect(fs.readdirSync(dir)).toEqual(['corrupt-entry.json.bad']);
  });

  it('is a no-op when the spool directory does not exist yet', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const db = openDb(dbFile);
    expect(() => drainSpool(db)).not.toThrow();
    db.close();
  });

  it('returns { drained: 0, locked: false } when there is nothing to drain', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const db = openDb(dbFile);
    expect(drainSpool(db)).toEqual({ drained: 0, locked: false });
    db.close();
  });

  it('returns { drained: N, locked: false } after draining a backlog with no contention', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'first' });
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p2', prompt: 'second' });

    const db = openDb(dbFile);
    expect(drainSpool(db)).toEqual({ drained: 2, locked: false });
    db.close();
  });

  it('fix round 1 (Critical): stops at the first lock error, leaving the rest of the backlog untouched', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p1', prompt: 'first' });
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p2', prompt: 'second' });
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p3', prompt: 'third' });

    const holder = openDb(dbFile); // creates the schema so the contended attempt below needs no migration write
    holder.exec('BEGIN IMMEDIATE');

    const db = openDb(dbFile, { busyTimeoutMs: 50 }); // short: this test only cares about stop-at-first, not timing
    const result = drainSpool(db);
    db.close();

    holder.exec('ROLLBACK');
    holder.close();

    expect(result).toEqual({ drained: 0, locked: true });
    // Nothing lost: all three files are still present (the first was un-claimed back to its original
    // name after the lock error; the other two were never even attempted).
    expect(fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.json'))).toHaveLength(3);
    expect(fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.claimed'))).toHaveLength(0);
  });
});

describe('drainSpool: stale .claimed recovery', () => {
  function claimManually(dir: string, ageMs?: number): string {
    const [name] = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const full = path.join(dir, name!);
    const claimed = `${full}.claimed`;
    fs.renameSync(full, claimed);
    if (ageMs !== undefined) {
      const old = new Date(Date.now() - ageMs);
      fs.utimesSync(claimed, old, old);
    }
    return claimed;
  }

  it('recovers a .claimed file older than STALE_CLAIM_MS and ingests it', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p-stale', prompt: 'stale claim' });
    const dir = spoolDir();
    const claimed = claimManually(dir, STALE_CLAIM_MS + 60_000);

    const db = openDb(dbFile);
    drainSpool(db);
    const row = db.prepare('SELECT content, source_ref FROM events').get() as
      | { content: string; source_ref: string }
      | undefined;
    db.close();

    expect(row).toEqual({ content: 'stale claim', source_ref: 'p-stale' });
    expect(fs.existsSync(claimed)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('leaves a fresh .claimed file alone (not yet stale)', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p-fresh', prompt: 'fresh claim' });
    const dir = spoolDir();
    const claimed = claimManually(dir); // fresh mtime, not backdated

    const db = openDb(dbFile);
    drainSpool(db);
    const count = db.prepare('SELECT count(*) FROM events').pluck().get();
    db.close();

    expect(count).toBe(0);
    expect(fs.existsSync(claimed)).toBe(true);
  });

  it('re-draining a recovered claim already ingested under its prompt_id creates no duplicate (sourceRef dedupe)', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    spoolPrompt({ session_id: 's1', cwd: null, transcript_path: null, prompt_id: 'p-dup', prompt: 'duplicate-prone' });
    const dir = spoolDir();
    claimManually(dir, STALE_CLAIM_MS + 60_000);

    const db = openDb(dbFile);
    // Simulate: the append already happened once (e.g. a prior process crashed between appending
    // and deleting the .claimed file), so the event already exists under this prompt_id.
    appendEvent(db, { sessionId: 's1', role: 'user', content: 'duplicate-prone', sourceRef: 'p-dup' });

    drainSpool(db);
    const count = db.prepare('SELECT count(*) FROM events').pluck().get();
    db.close();

    expect(count).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.claimed'))).toHaveLength(0);
  });
});
