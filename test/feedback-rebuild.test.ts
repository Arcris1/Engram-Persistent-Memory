import { describe, expect, it } from 'vitest';
import { recordFeedback } from '../src/claims/access.js';
import { readClaim, upsertClaims } from '../src/claims/claims.js';
import { computeImportance, recomputeImportance, recomputeImportanceFor } from '../src/control/importance.js';
import { pin } from '../src/control/marks.js';
import { setPaused } from '../src/control/pause.js';
import { rebuild } from '../src/control/rebuild.js';
import { appendEvent } from '../src/events/events.js';
import { openDb, type Db } from '../src/storage/db.js';
import { connectInMemory, runCli, textOf, tmpDbFile } from './helpers.js';

const NOW = '2026-10-01T00:00:00.000Z';
function daysAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 86_400_000).toISOString();
}

function seedClaim(db: Db, opts: { content?: string; kind?: 'message' | 'explicit_remember' } = {}): string {
  const content = opts.content ?? `We use tool-${Math.random().toString(36).slice(2)} in this repo`;
  const eventId = appendEvent(db, { sessionId: 'seed', role: 'user', content, kind: opts.kind }).id;
  const result = upsertClaims(db, {
    claims: [
      {
        subject: 'repo',
        predicate: 'uses_tool',
        object: content.slice(0, 20),
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

function addAccess(db: Db, claimId: string, opts: { ts: string; used: boolean; query?: string | null }): void {
  db.prepare(`INSERT INTO accesses (id, ts, target_id, query, used) VALUES (?, ?, ?, ?, ?)`).run(
    `acc-${Math.random().toString(36).slice(2)}`,
    opts.ts,
    claimId,
    opts.query ?? null,
    opts.used ? 1 : 0,
  );
}

describe('computeImportance (pure §7 formula)', () => {
  it('used_count=2 (sigmoid(0)=0.5) gives exactly 0.3 + 0.4*0.5 = 0.5', () => {
    expect(computeImportance({ usedCount: 2, pinned: false, explicitRemember: false })).toBeCloseTo(0.5, 9);
  });

  it('used_count=0 gives 0.3 + 0.4*sigmoid(-2)', () => {
    const expected = 0.3 + 0.4 * (1 / (1 + Math.exp(2)));
    expect(computeImportance({ usedCount: 0, pinned: false, explicitRemember: false })).toBeCloseTo(expected, 9);
  });

  it('is monotonically increasing in used_count', () => {
    const low = computeImportance({ usedCount: 0, pinned: false, explicitRemember: false });
    const mid = computeImportance({ usedCount: 2, pinned: false, explicitRemember: false });
    const high = computeImportance({ usedCount: 20, pinned: false, explicitRemember: false });
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it('never exceeds 0.7 from the formula alone (0.3 + 0.4*sigmoid, sigmoid <= 1 and saturates at huge x)', () => {
    const high = computeImportance({ usedCount: 1000, pinned: false, explicitRemember: false });
    expect(high).toBeLessThanOrEqual(0.7);
    const moderate = computeImportance({ usedCount: 10, pinned: false, explicitRemember: false });
    expect(moderate).toBeLessThan(0.7);
  });

  it('pinned overrides to 1.0 regardless of used_count or explicit_remember', () => {
    expect(computeImportance({ usedCount: 0, pinned: true, explicitRemember: false })).toBe(1.0);
    expect(computeImportance({ usedCount: 50, pinned: true, explicitRemember: true })).toBe(1.0);
  });

  it('explicit_remember floors an unpinned claim at 0.8, even with zero uses', () => {
    expect(computeImportance({ usedCount: 0, pinned: false, explicitRemember: true })).toBe(0.8);
  });

  it('explicit_remember floor still applies at high used_count (formula alone never reaches 0.8)', () => {
    expect(computeImportance({ usedCount: 1000, pinned: false, explicitRemember: true })).toBe(0.8);
  });
});

describe('recomputeImportanceFor / recomputeImportance (DB-level)', () => {
  it('counts only used=1 accesses within 180 days of now', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    addAccess(db, id, { ts: daysAgo(10), used: true });
    addAccess(db, id, { ts: daysAgo(20), used: true });
    addAccess(db, id, { ts: daysAgo(200), used: true }); // outside window
    addAccess(db, id, { ts: daysAgo(5), used: false }); // not used

    recomputeImportanceFor(db, [id], NOW);
    const expected = computeImportance({ usedCount: 2, pinned: false, explicitRemember: false });
    expect(readClaim(db, id)!.importance).toBeCloseTo(expected, 9);
    db.close();
  });

  it('a pinned claim recomputes to 1.0 regardless of usage', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    pin(db, id);
    recomputeImportanceFor(db, [id], NOW);
    expect(readClaim(db, id)!.importance).toBe(1.0);
    db.close();
  });

  it('a claim citing an explicit_remember source floors at 0.8 when unpinned', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db, { kind: 'explicit_remember' });
    recomputeImportanceFor(db, [id], NOW);
    expect(readClaim(db, id)!.importance).toBe(0.8);
    db.close();
  });

  it('recomputeImportance(db, now) recomputes every claim in the database', () => {
    const db = openDb(tmpDbFile());
    const a = seedClaim(db);
    const b = seedClaim(db);
    addAccess(db, a, { ts: daysAgo(1), used: true });
    addAccess(db, a, { ts: daysAgo(2), used: true });
    addAccess(db, a, { ts: daysAgo(3), used: true });

    recomputeImportance(db, NOW);

    const expectedA = computeImportance({ usedCount: 3, pinned: false, explicitRemember: false });
    const expectedB = computeImportance({ usedCount: 0, pinned: false, explicitRemember: false });
    expect(readClaim(db, a)!.importance).toBeCloseTo(expectedA, 9);
    expect(readClaim(db, b)!.importance).toBeCloseTo(expectedB, 9);
    db.close();
  });

  it('the 180-day window is inclusive: an access exactly 180 days old counts, one millisecond older does not', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    const windowStartMs = new Date(NOW).getTime() - 180 * 86_400_000;
    addAccess(db, id, { ts: new Date(windowStartMs).toISOString(), used: true }); // exactly at the boundary
    addAccess(db, id, { ts: new Date(windowStartMs - 1).toISOString(), used: true }); // 1ms older

    recomputeImportanceFor(db, [id], NOW);
    const expected = computeImportance({ usedCount: 1, pinned: false, explicitRemember: false });
    expect(readClaim(db, id)!.importance).toBeCloseTo(expected, 9);
    db.close();
  });

  it('recomputeImportanceFor is a no-op for an empty id list', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    const before = readClaim(db, id)!.importance;
    recomputeImportanceFor(db, [], NOW);
    expect(readClaim(db, id)!.importance).toBe(before);
    db.close();
  });
});

describe('recordFeedback (claims/access.ts)', () => {
  it('sets used on the most recent access row and recomputes importance', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    addAccess(db, id, { ts: daysAgo(10), query: 'q1', used: false });
    addAccess(db, id, { ts: daysAgo(1), query: 'q2', used: false }); // most recent

    const result = recordFeedback(db, [id], true, NOW);
    expect(result).toEqual({ updated: 1 });

    const rows = db
      .prepare(`SELECT query, used FROM accesses WHERE target_id = ? ORDER BY ts`)
      .all(id) as { query: string; used: number }[];
    expect(rows).toEqual([
      { query: 'q1', used: 0 },
      { query: 'q2', used: 1 },
    ]);

    const expected = computeImportance({ usedCount: 1, pinned: false, explicitRemember: false });
    expect(readClaim(db, id)!.importance).toBeCloseTo(expected, 9);
    db.close();
  });

  it('inserts a new access row with query=null when the claim has no access rows yet', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);

    const result = recordFeedback(db, [id], true, NOW);
    expect(result).toEqual({ updated: 1 });

    const rows = db.prepare(`SELECT query, used FROM accesses WHERE target_id = ?`).all(id) as {
      query: string | null;
      used: number;
    }[];
    expect(rows).toEqual([{ query: null, used: 1 }]);
    db.close();
  });

  it('used=false clears the most recent access row and lowers importance back down', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    addAccess(db, id, { ts: daysAgo(1), used: true });
    recomputeImportanceFor(db, [id], NOW);
    const highImportance = readClaim(db, id)!.importance;

    recordFeedback(db, [id], false, NOW);
    const lowImportance = readClaim(db, id)!.importance;
    expect(lowImportance).toBeLessThan(highImportance);
    db.close();
  });

  it('unknown ids are skipped and do not count toward updated', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    const result = recordFeedback(db, [id, 'does-not-exist'], true, NOW);
    expect(result).toEqual({ updated: 1 });
    db.close();
  });

  it('all-unknown ids updates nothing and returns {updated:0}', () => {
    const db = openDb(tmpDbFile());
    const result = recordFeedback(db, ['nope-1', 'nope-2'], true, NOW);
    expect(result).toEqual({ updated: 0 });
    db.close();
  });

  // J1.
  it('negative feedback on a never-accessed claim inserts nothing (must never raise activation)', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    const result = recordFeedback(db, [id], false, NOW);
    expect(result).toEqual({ updated: 1 });
    expect(db.prepare(`SELECT COUNT(*) FROM accesses WHERE target_id = ?`).pluck().get(id)).toBe(0);
    db.close();
  });

  // J1: documents that a "use" is per surfaced access (an accesses row), not per memory_feedback call
  // -- recordFeedback only ever touches the most recent accesses row, so repeated feedback with no
  // intervening search keeps updating that same single row rather than fabricating new ones.
  it('3 feedback calls without an intervening search still count as 1 used access', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    addAccess(db, id, { ts: daysAgo(1), used: false }); // simulates one search surfacing this claim

    recordFeedback(db, [id], true, NOW);
    recordFeedback(db, [id], true, NOW);
    recordFeedback(db, [id], true, NOW);

    expect(db.prepare(`SELECT COUNT(*) FROM accesses WHERE target_id = ?`).pluck().get(id)).toBe(1);
    const expected = computeImportance({ usedCount: 1, pinned: false, explicitRemember: false });
    expect(readClaim(db, id)!.importance).toBeCloseTo(expected, 9);
    db.close();
  });
});

// J1: a freshly-inserted claim's importance equals computeImportance(0 uses) -- the one importance
// scale, not an insert-time 0.5/0.8 constant. See also test/claims.test.ts's FRESH_IMPORTANCE checks.
describe('J1: one importance scale', () => {
  it("a fresh claim's importance equals computeImportance({usedCount: 0, pinned: false, explicitRemember: false})", () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    const expected = computeImportance({ usedCount: 0, pinned: false, explicitRemember: false });
    expect(readClaim(db, id)!.importance).toBeCloseTo(expected, 9);
    db.close();
  });

  it('real tool flow: search surfaces A and B tied on bm25; memory_feedback([A], true) makes A outrank B on a later search', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const statement = 'The gadget operates using the widget mechanism for testing purposes.';
    const ev = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'message',
      content: 'We discussed the widget mechanism at length.', ts: '2026-09-01T00:00:00.000Z',
    }).id;
    const a = upsertClaims(db, {
      claims: [{
        subject: 'alpha-item', predicate: 'calibrated_for', object: 'unit-one',
        statement, scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'the widget mechanism' }],
      }],
    }).inserted[0]!;
    const b = upsertClaims(db, {
      claims: [{
        subject: 'beta-item', predicate: 'calibrated_for', object: 'unit-two',
        statement, scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev, excerpt: 'the widget mechanism' }],
      }],
    }).inserted[0]!;

    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });

    const first = await client.callTool({ name: 'memory_search', arguments: { query: 'widget', mode: 'keyword', limit: 10 } });
    const firstIds = (first.structuredContent as { claims: { id: string }[] }).claims.map((c) => c.id);
    expect(firstIds.sort()).toEqual([a, b].sort());

    const fb = await client.callTool({ name: 'memory_feedback', arguments: { ids: [a], used: true } });
    expect(fb.structuredContent).toEqual({ updated: 1 });

    const second = await client.callTool({ name: 'memory_search', arguments: { query: 'widget', mode: 'keyword', limit: 10 } });
    const secondClaims = (second.structuredContent as { claims: { id: string; score: number | null }[] }).claims;
    const aHit = secondClaims.find((c) => c.id === a)!;
    const bHit = secondClaims.find((c) => c.id === b)!;
    expect(aHit.score!).toBeGreaterThan(bHit.score!);
    await client.close();
  });
});

async function setup() {
  const dbFile = tmpDbFile();
  const db = openDb(dbFile);
  const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });
  return { db, dbFile, client };
}

describe('memory_feedback MCP tool', () => {
  it('updates the most recent access and returns {updated}', async () => {
    const { db, client } = await setup();
    const id = seedClaim(db);
    addAccess(db, id, { ts: daysAgo(1), used: false });

    const r = await client.callTool({ name: 'memory_feedback', arguments: { ids: [id], used: true } });
    expect(r.structuredContent).toEqual({ updated: 1 });
    expect(textOf(r)).toContain('1');

    const row = db.prepare(`SELECT used FROM accesses WHERE target_id = ?`).get(id) as { used: number };
    expect(row.used).toBe(1);
    await client.close();
  });

  it('rejects an empty ids array', async () => {
    const { client } = await setup();
    const r = await client
      .callTool({ name: 'memory_feedback', arguments: { ids: [], used: true } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect((r as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it('rejects more than 50 ids', async () => {
    const { client } = await setup();
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const r = await client
      .callTool({ name: 'memory_feedback', arguments: { ids, used: true } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect((r as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it('while paused, returns {paused:true} and writes nothing', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const id = seedClaim(db);
    setPaused(true);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });

    const r = await client.callTool({ name: 'memory_feedback', arguments: { ids: [id], used: true } });
    expect(r.structuredContent).toEqual({ paused: true });
    expect(textOf(r)).toBe('engram is paused; nothing was written.');
    expect(db.prepare(`SELECT count(*) FROM accesses`).pluck().get()).toBe(0);
    setPaused(false);
    await client.close();
  });
});

describe('memory_rebuild MCP tool', () => {
  it('returns fts_checksum/importance_checksum as sha256 hex', async () => {
    const { db, client } = await setup();
    seedClaim(db);

    const r = await client.callTool({ name: 'memory_rebuild', arguments: {} });
    const result = r.structuredContent as { fts_checksum: string; importance_checksum: string };
    expect(result.fts_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.importance_checksum).toMatch(/^[0-9a-f]{64}$/);
    await client.close();
  });

  it('while paused, returns {paused:true}', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    setPaused(true);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });
    const r = await client.callTool({ name: 'memory_rebuild', arguments: {} });
    expect(r.structuredContent).toEqual({ paused: true });
    setPaused(false);
    await client.close();
  });
});

describe('rebuild() acceptance: idempotent and content-addressed (HANDOFF §4)', () => {
  it('two consecutive rebuilds give equal checksums', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db, { kind: 'explicit_remember' });
    seedClaim(db);
    addAccess(db, id, { ts: daysAgo(1), used: true });

    const first = rebuild(db, NOW);
    const second = rebuild(db, NOW);
    expect(second).toEqual(first);
    db.close();
  });

  it('checksums after an FTS delete-all + rebuild equal the original rebuild checksums', () => {
    const db = openDb(tmpDbFile());
    seedClaim(db, { kind: 'explicit_remember' });
    seedClaim(db);

    const before = rebuild(db, NOW);

    db.prepare(`INSERT INTO events_fts(events_fts) VALUES('delete-all')`).run();
    db.prepare(`INSERT INTO claims_fts(claims_fts) VALUES('delete-all')`).run();

    const after = rebuild(db, NOW);
    expect(after).toEqual(before);
    db.close();
  });

  it('rebuild recomputes importance for every claim, including unpinned ones with no accesses', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    db.prepare(`UPDATE claims SET importance = 0.999 WHERE id = ?`).run(id);

    rebuild(db, NOW);
    const expected = computeImportance({ usedCount: 0, pinned: false, explicitRemember: false });
    expect(readClaim(db, id)!.importance).toBeCloseTo(expected, 9);
    db.close();
  });
});

describe('rebuild() checksums are sensitive to real changes (not just a constant)', () => {
  it('importance_checksum changes when one claim\'s importance changes; fts_checksum does not', () => {
    const db = openDb(tmpDbFile());
    const id = seedClaim(db);
    const before = rebuild(db, NOW);

    pin(db, id); // forces this claim's importance to 1.0 -- no event/claim text changed
    const after = rebuild(db, NOW);

    expect(after.importance_checksum).not.toBe(before.importance_checksum);
    expect(after.fts_checksum).toBe(before.fts_checksum);
    db.close();
  });

  it('fts_checksum changes when one event is inserted; importance_checksum does not', () => {
    const db = openDb(tmpDbFile());
    seedClaim(db);
    const before = rebuild(db, NOW);

    appendEvent(db, { sessionId: 'seed', role: 'user', content: 'A brand new unrelated event for fts sensitivity' });
    const after = rebuild(db, NOW);

    expect(after.fts_checksum).not.toBe(before.fts_checksum);
    expect(after.importance_checksum).toBe(before.importance_checksum);
    db.close();
  });
});

describe('engram rebuild CLI', () => {
  it('rebuilds and prints a summary line with both checksums', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    seedClaim(db);
    db.close();

    const r = runCli(['rebuild'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/fts_checksum=[0-9a-f]{64}/);
    expect(r.stdout).toMatch(/importance_checksum=[0-9a-f]{64}/);
  });

  it('refuses with the exact paused text and exits 1 without writing', () => {
    const dbFile = tmpDbFile();
    runCli(['pause'], { dbFile }); // creates dataDir + the flag file only, no DB file
    const r = runCli(['rebuild'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe('engram is paused; nothing was written.');
  });
});

describe('engram maintain CLI', () => {
  it('rebuilds, optimizes, checkpoints, and prints a one-line summary', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    seedClaim(db);
    db.close();

    const r = runCli(['maintain'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toContain('maintain:');
    expect(r.stdout).toMatch(/fts_checksum=[0-9a-f]{12}/);
    expect(r.stdout).toContain('optimized');
    expect(r.stdout).toContain('checkpointed=');
  });

  it('refuses with the exact paused text and exits 1 without writing', () => {
    const dbFile = tmpDbFile();
    runCli(['pause'], { dbFile });
    const r = runCli(['maintain'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe('engram is paused; nothing was written.');
  });
});
