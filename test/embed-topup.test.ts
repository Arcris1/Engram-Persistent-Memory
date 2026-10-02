import { afterEach, describe, expect, it } from 'vitest';
import { setPaused } from '../src/control/pause.js';
import { createFakeEmbedder } from '../src/embed/fake.js';
import type { Embedder } from '../src/embed/embedder.js';
import { appendEvent } from '../src/events/events.js';
import { openDb } from '../src/storage/db.js';
import { connectInMemory, tmpDbFile } from './helpers.js';

async function setup(embedder: Embedder | null) {
  const dbFile = tmpDbFile();
  const db = openDb(dbFile);
  const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder });
  return { db, dbFile, client };
}

const embCount = (db: ReturnType<typeof openDb>): number =>
  db.prepare(`SELECT count(*) FROM embeddings`).pluck().get() as number;

let prevDb: string | undefined;
afterEach(() => {
  if (prevDb === undefined) delete process.env.ENGRAM_DB;
  else process.env.ENGRAM_DB = prevDb;
  prevDb = undefined;
});

/**
 * Phase 6 review (Important #5): the plan's "lazily before a search, for missing rows, bounded" --
 * hook-written events never get a vector from the post-write hook, so memory_search tops up a bounded
 * number of missing/stale rows (newest first) before it ranks.
 */
describe('MCP search: bounded lazy embedding top-up', () => {
  it('embeds a hook-written event (no vector) so it is scored by cosine in the same search', async () => {
    const { db, client } = await setup(createFakeEmbedder());
    const id = appendEvent(db, { sessionId: 's', role: 'user', content: 'deploy pipeline uses pnpm workspaces' }).id;
    expect(embCount(db)).toBe(0);
    const r = await client.callTool({ name: 'memory_search', arguments: { query: 'deploy pipeline pnpm' } });
    const events = (r.structuredContent as { events: { id: string; cosine: number | null }[] }).events;
    const hit = events.find((e) => e.id === id);
    expect(hit).toBeDefined();
    expect(typeof hit!.cosine).toBe('number');
    expect(embCount(db)).toBe(1);
    await client.close();
  });

  it('embeds at most 32 missing rows per search, newest first', async () => {
    const { db, client } = await setup(createFakeEmbedder());
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(appendEvent(db, { sessionId: 's', role: 'user', content: `note number ${i}` }).id);
    await client.callTool({ name: 'memory_search', arguments: { query: 'note' } });
    expect(embCount(db)).toBe(32);
    const embedded = new Set(db.prepare(`SELECT target_id FROM embeddings`).pluck().all() as string[]);
    for (const id of ids.slice(8)) expect(embedded.has(id)).toBe(true);
    for (const id of ids.slice(0, 8)) expect(embedded.has(id)).toBe(false);
    await client.close();
  });

  it('re-embeds a row whose stored vector came from a different model (model identity)', async () => {
    const { db, client } = await setup(createFakeEmbedder());
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'note about databases' });
    db.prepare(
      `INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at)
       VALUES ('event', ?, 'old-model@00000000', ?, 384, zeroblob(1536), '2026-01-01T00:00:00Z')`,
    ).run(ev.id, (db.prepare('SELECT content_hash FROM events WHERE id = ?').pluck().get(ev.id) as string));
    await client.callTool({ name: 'memory_search', arguments: { query: 'note' } });
    expect(db.prepare(`SELECT model FROM embeddings WHERE target_id = ?`).pluck().get(ev.id)).toBe('fake');
    await client.close();
  });

  it('a throwing embedder during top-up does not fail the search', async () => {
    const fake = createFakeEmbedder();
    let calls = 0;
    const flaky: Embedder = {
      model: 'fake', dim: fake.dim,
      async embed(texts) {
        // First call is the query embedding; every later call (the top-up) throws.
        if (++calls > 1) throw new Error('boom');
        return fake.embed(texts);
      },
    };
    const { db, client } = await setup(flaky);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'alpha beta gamma' });
    const r = await client.callTool({ name: 'memory_search', arguments: { query: 'alpha' } });
    expect(r.isError).toBeFalsy();
    const events = (r.structuredContent as { events: { content: string }[] }).events;
    expect(events.map((e) => e.content)).toContain('alpha beta gamma');
    expect(embCount(db)).toBe(0);
    await client.close();
  });

  it('disabled embedding: memory_search hits (events and claims) and profile claims carry no cosine key at all (protocol output unchanged)', async () => {
    const { db, client } = await setup(null);
    const ev = appendEvent(db, { sessionId: 's', role: 'user', content: 'We use PostgreSQL for billing.' });
    await client.callTool({
      name: 'memory_claim_upsert',
      arguments: { claims: [{
        subject: 'project:engram', predicate: 'uses_database', object: 'PostgreSQL',
        statement: 'engram uses PostgreSQL.', scope: 'fact', confidence: 0.9,
        sources: [{ event_id: ev.id, excerpt: 'We use PostgreSQL' }],
      }] },
    });
    const r = await client.callTool({ name: 'memory_search', arguments: { query: 'PostgreSQL' } });
    const sc = r.structuredContent as { events: object[]; claims: object[] };
    expect(sc.events.length + sc.claims.length).toBeGreaterThan(1);
    for (const h of [...sc.events, ...sc.claims]) expect('cosine' in h).toBe(false);
    const p = await client.callTool({ name: 'memory_profile', arguments: {} });
    const claims = (p.structuredContent as { claims?: object[] }).claims ?? [];
    for (const h of claims) expect('cosine' in h).toBe(false);
    await client.close();
  });

  it('writes no embeddings when embedding is disabled', async () => {
    const { db, client } = await setup(null);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'alpha beta gamma' });
    await client.callTool({ name: 'memory_search', arguments: { query: 'alpha' } });
    expect(embCount(db)).toBe(0);
    await client.close();
  });

  it('writes no embeddings while paused', async () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    prevDb = process.env.ENGRAM_DB;
    process.env.ENGRAM_DB = dbFile;
    setPaused(true);
    try {
      const client = await connectInMemory({ db, dbFile, defaultProject: 'engram', embedder: createFakeEmbedder() });
      appendEvent(db, { sessionId: 's', role: 'user', content: 'alpha beta gamma' });
      await client.callTool({ name: 'memory_search', arguments: { query: 'alpha' } });
      expect(embCount(db)).toBe(0);
      await client.close();
    } finally {
      setPaused(false);
    }
  });
});
