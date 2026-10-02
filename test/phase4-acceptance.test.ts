import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaim, upsertClaims, type ClaimInput } from '../src/claims/claims.js';
import { pin } from '../src/control/marks.js';
import { appendEvent, readEvent } from '../src/events/events.js';
import { setIngestOffset } from '../src/events/sessions.js';
import { ingestTranscript } from '../src/events/transcript.js';
import { openDb, type Db } from '../src/storage/db.js';
import { connectInMemory, runCli, textOf, tmpDbFile, tmpDir } from './helpers.js';

/**
 * HANDOFF §10 Phase 4 accept:
 * - forgetting an event deletes dependent claims and FTS rows;
 * - re-consolidating does not resurrect a forgotten claim;
 * - export → wipe → import → `engram stats` matches.
 *
 * Unit-level coverage of each mechanism (cascade counts, byte-level erasure, hash marks, tombstone
 * match rule, import idempotency) already lives in test/forget.test.ts, test/export-import.test.ts
 * and test/pin-pause.test.ts. This file exercises the three checks end to end, mostly through the
 * MCP in-memory client and the CLI, without re-asserting what those files already cover.
 */

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

describe('Phase 4 acceptance: forgetting an event deletes dependent claims and FTS rows', () => {
  it('events_fts and claims_fts no longer MATCH the forgotten content after memory_forget(confirm=true)', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });

    const eventId = appendEvent(db, {
      sessionId: 's', role: 'user', content: 'The canary marker zyxtrimorphine lives in billing config.',
    }).id;
    const claimId = upsertClaims(db, {
      claims: [claimInput(eventId, 'zyxtrimorphine lives in billing config', {
        statement: 'Billing config references zyxtrimorphine as its canary marker.',
      })],
    }).inserted[0]!;

    expect((db.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH 'zyxtrimorphine'`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT count(*) AS n FROM claims_fts WHERE claims_fts MATCH 'zyxtrimorphine'`).get() as { n: number }).n).toBe(1);

    const result = await client.callTool({ name: 'memory_forget', arguments: { id: eventId, confirm: true } });
    expect(result.structuredContent).toMatchObject({ deleted: { events: 1, claims: 1 } });

    expect((db.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH 'zyxtrimorphine'`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT count(*) AS n FROM claims_fts WHERE claims_fts MATCH 'zyxtrimorphine'`).get() as { n: number }).n).toBe(0);
    expect(readEvent(db, eventId)).toBeUndefined();
    expect(readClaim(db, claimId)).toBeUndefined();

    await client.close();
  });
});

describe('Phase 4 acceptance: re-consolidating does not resurrect a forgotten claim', () => {
  it('forgetting a claim via MCP, then re-upserting the same claim citing the same source, is rejected', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });

    const eventId = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' }).id;

    const upsert1 = await client.callTool({
      name: 'memory_claim_upsert',
      arguments: { claims: [claimInput(eventId, 'use PostgreSQL for billing')] },
    });
    const claimId = (upsert1.structuredContent as { inserted: string[] }).inserted[0]!;
    expect(claimId).toBeTruthy();

    // Preview first (confirm=false), as the §8.2 forget cue requires, then confirm.
    const preview = await client.callTool({ name: 'memory_forget', arguments: { id: claimId, confirm: false } });
    expect(textOf(preview)).toContain('Call again with confirm=true');
    const confirmed = await client.callTool({ name: 'memory_forget', arguments: { id: claimId, confirm: true } });
    expect((confirmed.structuredContent as { deleted: { claims: number } }).deleted.claims).toBe(1);
    expect(readClaim(db, claimId)).toBeUndefined();

    // "Re-consolidating": the same source event, re-extracted into the same claim, as /consolidate
    // would do if it reran over the same session without knowing the claim was forgotten.
    const upsert2 = await client.callTool({
      name: 'memory_claim_upsert',
      arguments: { claims: [claimInput(eventId, 'use PostgreSQL for billing')] },
    });
    const reUpsert = upsert2.structuredContent as {
      inserted: string[];
      rejected: Array<{ index: number; reason: string }>;
    };
    expect(reUpsert.inserted).toEqual([]);
    expect(reUpsert.rejected).toEqual([{ index: 0, reason: `event ${eventId} was forgotten` }]);

    await client.close();
  });

  it('forgetting an event, then re-ingesting the same transcript line (same uuid), is blocked by the tombstone', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });

    const sessionId = 'sess-resurrect';
    const transcript = path.join(tmpDir(), 'resurrect.jsonl');
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a-resurrect-1',
      timestamp: '2026-10-01T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'We will use Redis for caching.' }] },
    });
    fs.writeFileSync(transcript, `${line}\n`);

    const first = ingestTranscript(db, { sessionId, transcriptPath: transcript });
    expect(first.inserted).toBe(1);
    const eventId = db
      .prepare(`SELECT id FROM events WHERE session_id = ? AND source_ref = 'a-resurrect-1'`)
      .pluck()
      .get(sessionId) as string;

    const forgotten = await client.callTool({ name: 'memory_forget', arguments: { id: eventId, confirm: true } });
    expect((forgotten.structuredContent as { deleted: { events: number } }).deleted.events).toBe(1);

    // Simulate a transcript rescan of the exact same line (e.g. PreCompact / session-end re-running
    // over a transcript whose offset was reset) by rewinding this session's ingest offset to 0 --
    // the uuid in the file is unchanged, so a non-tombstoned event would simply be re-inserted.
    setIngestOffset(db, sessionId, 0);
    const second = ingestTranscript(db, { sessionId, transcriptPath: transcript });
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);

    const stillGone = db
      .prepare(`SELECT count(*) AS n FROM events WHERE session_id = ? AND source_ref = 'a-resurrect-1'`)
      .get(sessionId) as { n: number };
    expect(stillGone.n).toBe(0);

    await client.close();
  });
});

describe('Phase 4 acceptance: export -> wipe -> import makes engram stats match (CLI)', () => {
  function seed(db: Db): void {
    const eventA = appendEvent(db, {
      sessionId: 'sess-a', role: 'user', content: 'We decided to use PostgreSQL for billing.', project: 'engram',
    }).id;
    const eventB = appendEvent(db, {
      sessionId: 'sess-a', role: 'user', content: 'Later we moved billing to MySQL.', project: 'engram',
    }).id;
    const claimA = upsertClaims(db, { claims: [claimInput(eventA, 'use PostgreSQL for billing')] }).inserted[0]!;
    upsertClaims(db, {
      claims: [
        claimInput(eventB, 'moved billing to MySQL', {
          object: 'MySQL', statement: 'Billing moved to MySQL.', supersedes: claimA, valid_from: '2026-09-01',
        }),
      ],
    });
    const pinnedId = upsertClaims(db, {
      claims: [claimInput(eventA, 'use PostgreSQL for billing', { subject: 'project:billing2', object: 'Redis', statement: 'Billing also uses Redis.' })],
    }).inserted[0]!;
    pin(db, pinnedId, 'keep this one');
    db.prepare(
      `INSERT INTO accesses (id, ts, target_id, query, used) VALUES ('acc-1', '2026-01-01T00:00:00.000Z', ?, 'postgres', 1)`,
    ).run(pinnedId);
  }

  function wipeDbFiles(dbFile: string): void {
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });
  }

  function statsJson(dbFile: string): Record<string, unknown> {
    const r = runCli(['stats', '--json'], { dbFile });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  }

  it('engram stats --json is identical before and after, excluding db_path and db_bytes', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    seed(db);
    db.close();

    const statsBefore = statsJson(dbFile);

    const exportResult = runCli(['export'], { dbFile });
    expect(exportResult.status).toBe(0);
    const exportPath = exportResult.stdout.trim();
    expect(fs.existsSync(exportPath)).toBe(true);

    wipeDbFiles(dbFile);
    expect(fs.existsSync(dbFile)).toBe(false);

    const importResult = runCli(['import', exportPath], { dbFile });
    expect(importResult.status).toBe(0);

    const statsAfter = statsJson(dbFile);

    const strip = ({ db_path: _p, db_bytes: _b, ...rest }: Record<string, unknown>) => rest;
    expect(strip(statsAfter)).toEqual(strip(statsBefore));
    // Sanity: the round trip actually carried real content, not two empty DBs matching trivially.
    expect(statsAfter.events).toBe(2);
    expect((statsAfter.claims as { active: number; superseded: number }).active).toBe(2);
    expect((statsAfter.claims as { active: number; superseded: number }).superseded).toBe(1);
  });
});
