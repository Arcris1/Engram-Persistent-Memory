import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaim, upsertClaims, type ClaimRow } from '../src/claims/claims.js';
import { selectProfile } from '../src/claims/profile.js';
import { computeImportance } from '../src/control/importance.js';
import { pin, unpin } from '../src/control/marks.js';
import { isPaused, setPaused } from '../src/control/pause.js';
import { appendEvent } from '../src/events/events.js';
import { openDb, type Db } from '../src/storage/db.js';
import { connectInMemory, runCli, textOf, tmpDbFile, tmpDir } from './helpers.js';

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

// §7 formula for a never-accessed, unpinned, non-explicit_remember claim: 0.3 + 0.4*sigmoid(-2).
const UNPINNED_NO_ACCESS_IMPORTANCE = computeImportance({
  usedCount: 0,
  pinned: false,
  explicitRemember: false,
});

let seedCounter = 0;

function seedClaim(db: Db, opts: { content?: string; kind?: 'message' | 'explicit_remember' } = {}): string {
  seedCounter += 1;
  const content = opts.content ?? `We use tool-${seedCounter} in this repo`;
  const eventId = appendEvent(db, { sessionId: 'seed', role: 'user', content, kind: opts.kind }).id;
  const result = upsertClaims(db, {
    claims: [
      {
        subject: 'repo',
        predicate: 'uses_tool',
        object: `tool-${seedCounter}`,
        statement: content,
        scope: 'fact',
        confidence: 0.9,
        project: null,
        sources: [{ event_id: eventId, excerpt: content.slice(0, 20) }],
      },
    ],
  });
  if (result.rejected.length > 0) throw new Error(`seedClaim rejected: ${result.rejected[0]!.reason}`);
  return result.inserted[0]!;
}

describe('control/marks: pin/unpin', () => {
  it('pin sets importance to 1.0, upserts a pinned mark with the note, and orders the claim first in the profile', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const idA = seedClaim(db, { content: 'Claim A is about alpha topics' });
    const idB = seedClaim(db, { content: 'Claim B is about beta topics' });

    const result = pin(db, idA, 'important for reasons');
    expect(result).toEqual({ id: idA, pinned: true, importance: 1.0 });
    expect(readClaim(db, idA)!.importance).toBe(1.0);

    const mark = db
      .prepare(`SELECT note FROM marks WHERE target_id = ? AND kind = 'pinned'`)
      .get(idA) as { note: string } | undefined;
    expect(mark?.note).toBe('important for reasons');

    const profile = selectProfile(db, { project: null });
    const ids = profile.map((c: ClaimRow) => c.id);
    expect(ids[0]).toBe(idA);
    expect(ids).toContain(idB);
    db.close();
  });

  it('re-pinning updates the note (upsert, not a duplicate row)', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const id = seedClaim(db);
    pin(db, id, 'first note');
    pin(db, id, 'second note');
    const rows = db.prepare(`SELECT note FROM marks WHERE target_id = ? AND kind = 'pinned'`).all(id);
    expect(rows).toEqual([{ note: 'second note' }]);
    db.close();
  });

  it('pin throws for an unknown claim id', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    expect(() => pin(db, 'does-not-exist')).toThrow(/no claim/);
    db.close();
  });

  it('unpin removes the mark and recomputes importance via the §7 formula without an explicit_remember source', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const id = seedClaim(db);
    pin(db, id);

    const result = unpin(db, id);
    expect(result).toEqual({ id, pinned: false, importance: UNPINNED_NO_ACCESS_IMPORTANCE });
    expect(readClaim(db, id)!.importance).toBe(UNPINNED_NO_ACCESS_IMPORTANCE);
    const mark = db.prepare(`SELECT 1 FROM marks WHERE target_id = ? AND kind = 'pinned'`).get(id);
    expect(mark).toBeUndefined();
    db.close();
  });

  it('unpin recomputes importance as 0.8 when a source event is explicit_remember', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const id = seedClaim(db, { kind: 'explicit_remember' });
    pin(db, id);

    const result = unpin(db, id);
    expect(result.importance).toBe(0.8);
    db.close();
  });

  it('unpin throws for an unknown claim id', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    expect(() => unpin(db, 'does-not-exist')).toThrow(/no claim/);
    db.close();
  });
});

async function mcpSetup() {
  const dbFile = tmpDbFile();
  const db = openDb(dbFile);
  const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });
  return { db, dbFile, client };
}

describe('memory_pin / memory_unpin MCP tools', () => {
  it('pins and unpins a claim end to end', async () => {
    const { db, client } = await mcpSetup();
    const id = seedClaim(db);

    const pinned = await client.callTool({ name: 'memory_pin', arguments: { id, note: 'keep this' } });
    expect(pinned.structuredContent).toEqual({ id, pinned: true, importance: 1.0 });
    expect(textOf(pinned)).toContain(id);

    const unpinned = await client.callTool({ name: 'memory_unpin', arguments: { id } });
    expect(unpinned.structuredContent).toEqual({ id, pinned: false, importance: UNPINNED_NO_ACCESS_IMPORTANCE });

    await client.close();
  });

  it('memory_pin rejects an unknown claim id', async () => {
    const { client } = await mcpSetup();
    const r = await client
      .callTool({ name: 'memory_pin', arguments: { id: 'nope' } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect((r as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });
});

describe('pause: isPaused()/setPaused()', () => {
  it('flips the flag file under dataDir and isPaused reflects it', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    expect(isPaused()).toBe(false);
    setPaused(true);
    expect(isPaused()).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(dbFile), 'paused'))).toBe(true);
    setPaused(false);
    expect(isPaused()).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(dbFile), 'paused'))).toBe(false);
  });

  it('setPaused(false) on an already-resumed store is a no-op, not a throw', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    expect(() => setPaused(false)).not.toThrow();
  });
});

describe('engram pause / resume / status CLI', () => {
  it('status starts active, pause flips it, resume flips it back', () => {
    const dbFile = tmpDbFile();
    expect(runCli(['status'], { dbFile }).stdout).toBe('active\n');
    expect(runCli(['pause'], { dbFile }).stdout).toBe('paused\n');
    expect(runCli(['status'], { dbFile }).stdout).toBe('paused\n');
    expect(runCli(['resume'], { dbFile }).stdout).toBe('active\n');
    expect(runCli(['status'], { dbFile }).stdout).toBe('active\n');
  });
});

describe('pause: hooks are a no-op', () => {
  const hookJson = (extra: Record<string, unknown>) =>
    JSON.stringify({ session_id: 'sess-1', cwd: process.cwd(), hook_event_name: 'UserPromptSubmit', ...extra });

  it('a fresh, paused dataDir never gets a DB file from a hook call', () => {
    const dbFile = tmpDbFile(); // not-yet-existing directory
    runCli(['pause'], { dbFile }); // creates dataDir + the flag file only
    expect(fs.existsSync(dbFile)).toBe(false);

    const r = runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'should not be stored' }) });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(fs.existsSync(dbFile)).toBe(false);
  });

  it('session-start prints nothing while paused, even with a seeded profile', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const id = seedClaim(db);
    pin(db, id);
    db.close();

    runCli(['pause'], { dbFile });
    const r = runCli(['session-start'], {
      dbFile,
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: process.cwd(), hook_event_name: 'SessionStart' }),
    });
    expect(r).toMatchObject({ status: 0, stdout: '' });
  });

  it('resuming lets hooks write again', () => {
    const dbFile = tmpDbFile();
    runCli(['pause'], { dbFile });
    runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'dropped while paused' }) });
    expect(fs.existsSync(dbFile)).toBe(false);

    runCli(['resume'], { dbFile });
    runCli(['ingest-prompt'], { dbFile, stdin: hookJson({ prompt: 'stored once active' }) });
    const db = openDb(dbFile);
    const rows = db.prepare('SELECT content FROM events').all() as Array<{ content: string }>;
    db.close();
    expect(rows).toEqual([{ content: 'stored once active' }]);
  });
});

describe('pause: guarded MCP write tools', () => {
  async function pausedSetup() {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile); // creates the DB file up front, as the live MCP server process would
    useDb(dbFile);
    setPaused(true);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });
    return { db, dbFile, client };
  }

  function countRows(db: Db, table: string): number {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  it('memory_record returns {paused:true} and writes no event', async () => {
    const { db, client } = await pausedSetup();
    const before = countRows(db, 'events');
    const r = await client.callTool({ name: 'memory_record', arguments: { content: 'should not be stored' } });
    expect(r.structuredContent).toEqual({ paused: true });
    expect(textOf(r)).toBe('engram is paused; nothing was written.');
    expect(countRows(db, 'events')).toBe(before);
    await client.close();
  });

  it('memory_claim_upsert returns {paused:true} and writes no claim', async () => {
    const { db, client } = await pausedSetup();
    const before = countRows(db, 'claims');
    const r = await client.callTool({
      name: 'memory_claim_upsert',
      arguments: {
        claims: [
          {
            subject: 'repo',
            predicate: 'uses_tool',
            object: 'pnpm',
            statement: 'uses pnpm',
            scope: 'fact',
            confidence: 0.9,
            sources: [{ event_id: 'whatever', excerpt: 'uses pnpm' }],
          },
        ],
      },
    });
    expect(r.structuredContent).toEqual({ paused: true });
    expect(countRows(db, 'claims')).toBe(before);
    await client.close();
  });

  it('memory_reset_claims(confirm=true) returns {paused:true} and deletes nothing, but confirm=false preview still works', async () => {
    const { db, client } = await pausedSetup();
    const id = seedClaim(db);
    const preview = await client.callTool({ name: 'memory_reset_claims', arguments: { confirm: false } });
    expect(preview.structuredContent).toMatchObject({ claims: 1, done: false });

    const confirmed = await client.callTool({ name: 'memory_reset_claims', arguments: { confirm: true } });
    expect(confirmed.structuredContent).toEqual({ paused: true });
    expect(readClaim(db, id)).toBeDefined();
    await client.close();
  });

  it('memory_forget(confirm=true) returns {paused:true} and deletes nothing, but confirm=false preview still works', async () => {
    const { db, client } = await pausedSetup();
    const id = seedClaim(db);
    const preview = await client.callTool({ name: 'memory_forget', arguments: { id, confirm: false } });
    expect((preview.structuredContent as { deleted: { claims: number } }).deleted.claims).toBe(1);

    const confirmed = await client.callTool({ name: 'memory_forget', arguments: { id, confirm: true } });
    expect(confirmed.structuredContent).toEqual({ paused: true });
    expect(readClaim(db, id)).toBeDefined();
    await client.close();
  });

  it('memory_pin and memory_unpin return {paused:true} and change nothing', async () => {
    const { db, client } = await pausedSetup();
    const id = seedClaim(db);

    const pinned = await client.callTool({ name: 'memory_pin', arguments: { id } });
    expect(pinned.structuredContent).toEqual({ paused: true });
    expect(readClaim(db, id)!.importance).toBeCloseTo(UNPINNED_NO_ACCESS_IMPORTANCE, 9);

    const unpinned = await client.callTool({ name: 'memory_unpin', arguments: { id } });
    expect(unpinned.structuredContent).toEqual({ paused: true });

    await client.close();
  });

  it('read tools keep working while paused: memory_profile, memory_stats, memory_pending', async () => {
    const { db, client } = await pausedSetup();
    seedClaim(db);

    const profile = await client.callTool({ name: 'memory_profile', arguments: {} });
    expect((profile.structuredContent as { claims: unknown[] }).claims).toHaveLength(1);

    const stats = await client.callTool({ name: 'memory_stats', arguments: {} });
    expect(stats.isError).not.toBe(true);

    const pending = await client.callTool({ name: 'memory_pending', arguments: {} });
    expect(pending.isError).not.toBe(true);

    await client.close();
  });

  it('memory_search still returns results while paused, but skips logging the access', async () => {
    const { db, client } = await pausedSetup();
    const id = seedClaim(db, { content: 'pause search target phrase' });
    const before = countRows(db, 'accesses');

    const r = await client.callTool({ name: 'memory_search', arguments: { query: 'pause search target' } });
    const claims = (r.structuredContent as { claims: Array<{ id: string }> }).claims;
    expect(claims.map((c) => c.id)).toContain(id);
    expect(countRows(db, 'accesses')).toBe(before);
    expect(readClaim(db, id)!.access_count).toBe(0);

    await client.close();
  });
});
