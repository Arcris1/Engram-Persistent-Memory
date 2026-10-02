import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events/events.js';
import { ingestTranscript } from '../src/events/transcript.js';
import { openDb, type Db } from '../src/storage/db.js';
import { connectInMemory, ROOT, textOf, tmpDbFile, tmpDir } from './helpers.js';

const FIXTURE = path.join(ROOT, 'test/fixtures/transcript.jsonl');

function copyFixture(): string {
  const file = path.join(tmpDir(), 'session.jsonl');
  fs.copyFileSync(FIXTURE, file);
  return file;
}

async function setup() {
  const dbFile = tmpDbFile();
  const db = openDb(dbFile);
  const client = await connectInMemory({ db, dbFile, defaultProject: 'engram' });
  return { db, client };
}

const call = (client: Awaited<ReturnType<typeof setup>>['client'], name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

function seedEvent(db: Db, content = 'We settled on pnpm for this repo') {
  return appendEvent(db, { sessionId: 's1', role: 'user', kind: 'message', content }).id;
}

describe('Phase 2 acceptance (HANDOFF §6.12 / §6.5)', () => {
  it('rejects a claim submitted without sources', async () => {
    const { db, client } = await setup();
    seedEvent(db);
    const r = await call(client, 'memory_claim_upsert', {
      claims: [{
        subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
        statement: 'User prefers pnpm.', scope: 'fact', confidence: 0.9,
        sources: [],
      }],
    });
    const out = r.structuredContent as { inserted: string[]; rejected: { index: number; reason: string }[] };
    expect(out.inserted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.index).toBe(0);
    expect(out.rejected[0]!.reason).toMatch(/no sources/i);
  });

  it('rejects a claim whose excerpt is not found verbatim in the cited event', async () => {
    const { db, client } = await setup();
    const eventId = seedEvent(db);
    const r = await call(client, 'memory_claim_upsert', {
      claims: [{
        subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
        statement: 'User prefers pnpm.', scope: 'fact', confidence: 0.9,
        sources: [{ event_id: eventId, excerpt: 'this text is not in the event' }],
      }],
    });
    const out = r.structuredContent as { inserted: string[]; rejected: { index: number; reason: string }[] };
    expect(out.inserted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toMatch(/excerpt not found/i);
  });

  it('superseding an existing claim sets valid_to on the old claim', async () => {
    const { db, client } = await setup();
    const firstEvent = seedEvent(db, 'We settled on pnpm for this repo');
    const upsert1 = await call(client, 'memory_claim_upsert', {
      claims: [{
        subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
        statement: 'User prefers pnpm.', scope: 'fact', confidence: 0.9,
        sources: [{ event_id: firstEvent, excerpt: 'settled on pnpm' }],
      }],
    });
    const oldId = (upsert1.structuredContent as { inserted: string[] }).inserted[0]!;

    const secondEvent = appendEvent(db, {
      sessionId: 's1', role: 'user', kind: 'message', content: 'Actually we switched to npm for this repo',
    }).id;
    const upsert2 = await call(client, 'memory_claim_upsert', {
      claims: [{
        subject: 'user', predicate: 'prefers_package_manager', object: 'npm',
        statement: 'User prefers npm.', scope: 'fact', confidence: 0.9,
        sources: [{ event_id: secondEvent, excerpt: 'switched to npm' }],
        supersedes: oldId,
      }],
    });
    const out2 = upsert2.structuredContent as { inserted: string[]; superseded: string[] };
    expect(out2.inserted).toHaveLength(1);
    expect(out2.superseded).toEqual([oldId]);

    const explained = await call(client, 'memory_explain', { id: oldId });
    const oldClaim = (explained.structuredContent as { explanation: { item: { status: string; valid_to: string | null } } })
      .explanation.item;
    expect(oldClaim.status).toBe('superseded');
    expect(oldClaim.valid_to).not.toBeNull();
  });

  it('a scripted consolidation of the fixture transcript produces a cited claim visible through memory_explain', async () => {
    const { db, client } = await setup();
    const file = copyFixture();
    const ingestResult = ingestTranscript(db, {
      sessionId: 'sess-fixture', transcriptPath: file, project: 'engram',
    });
    expect(ingestResult.inserted).toBe(3);

    // F8: rule 8 forbids turning Claude's own recommendation into a fact ("opinions Claude expressed")
    // -- only the user's decisions and facts are extractable claims. Ingest the user's own decision as
    // a separate event and cite *that*, not the assistant's "I recommend PostgreSQL" text.
    const userDecisionId = appendEvent(db, {
      sessionId: 'sess-fixture', role: 'user', kind: 'message', project: 'engram',
      content: 'We decided the billing service uses PostgreSQL.',
    }).id;

    const pendingResult = await call(client, 'memory_pending', { session_id: 'sess-fixture' });
    const pending = pendingResult.structuredContent as {
      sessions: Array<{ session_id: string; events: Array<{ id: string; content: string; extractable: boolean }> }>;
    };
    expect(pending.sessions).toHaveLength(1);
    const pgEvent = pending.sessions[0]!.events.find((e) => e.content.includes('I recommend PostgreSQL'));
    expect(pgEvent).toBeDefined();
    // Assistant text, not instruction-like, so it is still extractable in principle -- the server's
    // D23 extractability gate has nothing against it. Keeping Claude's own opinions out of claims is
    // the consolidation prompt's job (rule 8), not something the server enforces here.
    expect(pgEvent!.extractable).toBe(true);

    const userEvent = pending.sessions[0]!.events.find((e) => e.id === userDecisionId);
    expect(userEvent).toBeDefined();
    expect(userEvent!.extractable).toBe(true);

    const upsertResult = await call(client, 'memory_claim_upsert', {
      claims: [{
        subject: 'project:engram', predicate: 'uses_database', object: 'PostgreSQL',
        statement: 'The billing service uses PostgreSQL.', scope: 'fact', confidence: 0.8,
        sources: [{ event_id: userEvent!.id, excerpt: 'the billing service uses PostgreSQL' }],
      }],
      mark_session_consolidated: 'sess-fixture',
    });
    const upsert = upsertResult.structuredContent as { inserted: string[]; rejected: unknown[] };
    expect(upsert.rejected).toEqual([]);
    expect(upsert.inserted).toHaveLength(1);
    const claimId = upsert.inserted[0]!;
    expect(textOf(upsertResult)).toContain('inserted 1');

    const explained = await call(client, 'memory_explain', { id: claimId });
    const explanation = (explained.structuredContent as {
      explanation: { kind: string; item: { statement: string }; sources: Array<{ event: { id: string } }> };
    }).explanation;
    expect(explanation.kind).toBe('claim');
    expect(explanation.item.statement).toContain('PostgreSQL');
    expect(explanation.sources.map((s) => s.event.id)).toEqual([userEvent!.id]);
  });
});
