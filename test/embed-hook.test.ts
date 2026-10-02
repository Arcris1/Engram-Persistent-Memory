import { afterEach, describe, expect, it } from 'vitest';
import { createFakeEmbedder } from '../src/embed/fake.js';
import { claimContentHash, loadVectors } from '../src/embed/store.js';
import { setPaused } from '../src/control/pause.js';
import { openDb } from '../src/storage/db.js';
import { connectInMemory, tmpDbFile } from './helpers.js';

async function setup(embedder: ReturnType<typeof createFakeEmbedder> | null = createFakeEmbedder()) {
  const dbFile = tmpDbFile();
  const db = openDb(dbFile);
  const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder });
  return { db, client };
}

let prevDb: string | undefined;
afterEach(() => {
  if (prevDb === undefined) delete process.env.ENGRAM_DB;
  else process.env.ENGRAM_DB = prevDb;
  prevDb = undefined;
});

describe('MCP post-write embedding hook (D42/Phase 6 Task 2)', () => {
  it('memory_record embeds the new event when an embedder is injected', async () => {
    const { db, client } = await setup();
    const r = await client.callTool({ name: 'memory_record', arguments: { content: 'Remember: use pnpm.' } });
    const { event_id } = r.structuredContent as { event_id: string };

    const vecs = loadVectors(db, 'event', [event_id]);
    expect(vecs.has(event_id)).toBe(true);
    const row = db.prepare(`SELECT model, content_hash FROM embeddings WHERE target_kind = 'event' AND target_id = ?`).get(
      event_id,
    ) as { model: string; content_hash: string };
    expect(row.model).toBe('fake');
    const expectedHash = db.prepare(`SELECT content_hash FROM events WHERE id = ?`).pluck().get(event_id);
    expect(row.content_hash).toBe(expectedHash);
    await client.close();
  });

  it('memory_record does nothing embedding-wise when embedder is null (disabled)', async () => {
    const { db, client } = await setup(null);
    const r = await client.callTool({ name: 'memory_record', arguments: { content: 'No embedder configured.' } });
    const { event_id } = r.structuredContent as { event_id: string };
    expect(loadVectors(db, 'event', [event_id]).size).toBe(0);
    const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(0);
    await client.close();
  });

  it('memory_claim_upsert embeds every inserted claim', async () => {
    const { db, client } = await setup();
    const recordResult = await client.callTool({ name: 'memory_record', arguments: { content: 'We settled on pnpm for this repo.' } });
    const { event_id } = recordResult.structuredContent as { event_id: string };

    const upsertResult = await client.callTool({
      name: 'memory_claim_upsert',
      arguments: {
        claims: [{
          subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
          statement: 'User prefers pnpm.', scope: 'fact', confidence: 0.9,
          sources: [{ event_id, excerpt: 'settled on pnpm' }],
        }],
      },
    });
    const { inserted } = upsertResult.structuredContent as { inserted: string[] };
    expect(inserted).toHaveLength(1);
    const claimId = inserted[0]!;

    const vecs = loadVectors(db, 'claim', [claimId]);
    expect(vecs.has(claimId)).toBe(true);
    const row = db.prepare(`SELECT content_hash FROM embeddings WHERE target_kind = 'claim' AND target_id = ?`).get(claimId) as {
      content_hash: string;
    };
    expect(row.content_hash).toBe(claimContentHash('user', 'User prefers pnpm.', 'pnpm'));
    await client.close();
  });

  it('memory_claim_upsert: a rejected claim is never embedded', async () => {
    const { db, client } = await setup();
    const upsertResult = await client.callTool({
      name: 'memory_claim_upsert',
      arguments: {
        claims: [{
          subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
          statement: 'User prefers pnpm.', scope: 'fact', confidence: 0.9,
          sources: [{ event_id: 'does-not-exist', excerpt: 'settled on pnpm' }],
        }],
      },
    });
    const result = upsertResult.structuredContent as { inserted: string[]; rejected: unknown[] };
    expect(result.inserted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(0);
    await client.close();
  });

  // Carried over from the Task 2 review: memory_claim_upsert's own embedding loop must be just as
  // resilient to a throwing embedder as memory_record's single-row hook already is (embedAfterWrite
  // catches internally) -- the tool's own result (inserted/merged/rejected) must be unaffected.
  it('memory_claim_upsert succeeds, with an unchanged result, even when the embedder throws', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const throwingEmbedder = { model: 'broken', dim: 4, embed: async () => { throw new Error('boom'); } };
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder: throwingEmbedder });

    const recordResult = await client.callTool({ name: 'memory_record', arguments: { content: 'We settled on pnpm for this repo.' } });
    const { event_id } = recordResult.structuredContent as { event_id: string };

    const upsertResult = await client.callTool({
      name: 'memory_claim_upsert',
      arguments: {
        claims: [{
          subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
          statement: 'User prefers pnpm.', scope: 'fact', confidence: 0.9,
          sources: [{ event_id, excerpt: 'settled on pnpm' }],
        }],
      },
    });
    expect(upsertResult.isError).not.toBe(true);
    const result = upsertResult.structuredContent as { inserted: string[]; merged: string[]; rejected: unknown[] };
    expect(result.inserted).toHaveLength(1);
    expect(result.merged).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);

    const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(0);
    await client.close();
  });

  // Carried over from the Task 2 review: a realistically large single batch (the tool's own max of
  // 100 claims) must embed every claim via the fake embedder within a bounded time -- this is not a
  // precise perf benchmark, just a regression guard against an accidental O(n^2) or per-claim
  // model-reload cost creeping into the embed-after-upsert loop.
  it('a 100-claim upsert embeds every claim within a bounded time (< 2s) with the fake embedder', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder: createFakeEmbedder() });

    const n = 100;
    const phrases = Array.from({ length: n }, (_, i) => `Fact number ${i} is true.`);
    const recordResult = await client.callTool({ name: 'memory_record', arguments: { content: phrases.join(' ') } });
    const { event_id } = recordResult.structuredContent as { event_id: string };

    const claims = phrases.map((phrase, i) => ({
      subject: `thing:${i}`, predicate: 'is', object: 'true',
      statement: phrase, scope: 'fact' as const, confidence: 0.9,
      sources: [{ event_id, excerpt: phrase }],
    }));

    const started = Date.now();
    const upsertResult = await client.callTool({ name: 'memory_claim_upsert', arguments: { claims } });
    const elapsedMs = Date.now() - started;

    const result = upsertResult.structuredContent as { inserted: string[]; rejected: unknown[] };
    expect(result.rejected).toHaveLength(0);
    expect(result.inserted).toHaveLength(n);
    expect(elapsedMs).toBeLessThan(2000);

    const embeddedCount = db.prepare(`SELECT count(*) FROM embeddings WHERE target_kind = 'claim'`).pluck().get();
    expect(embeddedCount).toBe(n);
    const vecs = loadVectors(db, 'claim', result.inserted);
    expect(vecs.size).toBe(n);
    await client.close();
  });

  it('a failing embedder never fails the memory_record tool call (errors are caught, not thrown)', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const throwingEmbedder = { model: 'broken', dim: 4, embed: async () => { throw new Error('boom'); } };
    const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder: throwingEmbedder });

    const r = await client.callTool({ name: 'memory_record', arguments: { content: 'Still recorded despite embed failure.' } });
    expect(r.isError).not.toBe(true);
    const { event_id } = r.structuredContent as { event_id: string };
    expect(event_id).not.toBe('');
    const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(0);
    await client.close();
  });

  it('memory_record is skipped embedding-wise while paused (the write itself is skipped)', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    // isPaused()/setPaused() key off dbPath()'s directory (via ENGRAM_DB) -- point it at this test's
    // own tmp dir, never the real ~/.engram.
    prevDb = process.env.ENGRAM_DB;
    process.env.ENGRAM_DB = dbFile;
    setPaused(true);
    try {
      const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder: createFakeEmbedder() });
      const r = await client.callTool({ name: 'memory_record', arguments: { content: 'Should not be recorded.' } });
      expect((r.structuredContent as { paused?: boolean }).paused).toBe(true);
      const count = db.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
      expect(count).toBe(0);
      await client.close();
    } finally {
      setPaused(false);
    }
  });
});
