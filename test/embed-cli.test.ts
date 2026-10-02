import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeEmbedder } from '../src/embed/fake.js';
import { openDb } from '../src/storage/db.js';
import { appendEvent } from '../src/events/events.js';
import { runCli, tmpDbFile } from './helpers.js';

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

describe('engram embed / engram maintain --embed (CLI wiring, D42/Phase 6 Task 2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('engram embed: disabled (default, no config.json) -> exit 1, reason on stderr, no DB touched', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['embed'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('disabled');
  });

  it('engram embed: refuses while paused, before even resolving the embedder', () => {
    const dbFile = tmpDbFile();
    runCli(['pause'], { dbFile });
    const r = runCli(['embed'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('paused');
  });

  it('engram maintain --embed: disabled embedding does not fail the whole maintain run', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['maintain', '--embed'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('embed skipped (disabled)');
    expect(r.stdout).toContain('maintain: rebuilt');
  });

  it('engram maintain (no --embed flag) never mentions embedding', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['maintain'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('embed');
  });

  it('embedCommand actually backfills via the resolved embedder (injection seam: mocked tryLoadEmbedder)', async () => {
    useDb(tmpDbFile());
    const fake = createFakeEmbedder();
    vi.doMock('../src/embed/load.js', () => ({
      tryLoadEmbedder: async () => ({ embedder: fake, reason: 'ok' }),
    }));
    const { embedCommand } = await import('../src/cli/commands/embed.js');

    const db = openDb(process.env.ENGRAM_DB!);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'Backfill me.' });
    db.close();

    const status = await embedCommand([]);
    expect(status).toBe(0);

    const reopened = openDb(process.env.ENGRAM_DB!);
    const count = reopened.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(1);
    reopened.close();
  });

  it('maintainCommand(["--embed"]) backfills too, via the same mocked embedder', async () => {
    useDb(tmpDbFile());
    const fake = createFakeEmbedder();
    vi.doMock('../src/embed/load.js', () => ({
      tryLoadEmbedder: async () => ({ embedder: fake, reason: 'ok' }),
    }));
    const { maintainCommand } = await import('../src/cli/commands/maintain.js');

    const db = openDb(process.env.ENGRAM_DB!);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'Backfill me too.' });
    db.close();

    const status = await maintainCommand(['--embed']);
    expect(status).toBe(0);

    const reopened = openDb(process.env.ENGRAM_DB!);
    const count = reopened.prepare(`SELECT count(*) FROM embeddings`).pluck().get();
    expect(count).toBe(1);
    reopened.close();
  });

  it('Phase 6 re-review: maintain --embed with a failing embedder still rebuilds/checkpoints and exits 0', async () => {
    useDb(tmpDbFile());
    const fake = createFakeEmbedder();
    vi.doMock('../src/embed/load.js', () => ({
      tryLoadEmbedder: async () => ({
        embedder: { ...fake, embed: async () => { throw new Error('boom'); } },
        reason: 'ok',
      }),
    }));
    const { maintainCommand } = await import('../src/cli/commands/maintain.js');
    const db = openDb(process.env.ENGRAM_DB!);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'Will fail to embed.' });
    db.close();

    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let status: number;
    let stderr: string;
    let stdout: string;
    try {
      status = await maintainCommand(['--embed']);
    } finally {
      stderr = err.mock.calls.map((c) => String(c[0])).join('');
      stdout = out.mock.calls.map((c) => String(c[0])).join('');
      err.mockRestore();
      out.mockRestore();
    }
    expect(status).toBe(0);
    expect(stderr).toContain('maintain --embed failed: boom');
    expect(stdout).toMatch(/maintain: rebuilt .*checkpointed=true, embed failed/);
  });

  it.each(['embed', 'maintain'] as const)(
    'Phase 6 review: %s sweeps orphan embeddings',
    async (name) => {
      useDb(tmpDbFile());
      const fake = createFakeEmbedder();
      vi.doMock('../src/embed/load.js', () => ({
        tryLoadEmbedder: async () => ({ embedder: fake, reason: 'ok' }),
      }));
      const db = openDb(process.env.ENGRAM_DB!);
      appendEvent(db, { sessionId: 's', role: 'user', content: 'Alive.' });
      db.prepare(
        `INSERT INTO embeddings (target_kind, target_id, model, dim, content_hash, vec, created_at) VALUES ('event', 'orphan', 'fake', 1, 'h', x'00000000', '2026-01-01T00:00:00Z')`,
      ).run();
      db.close();

      if (name === 'embed') await (await import('../src/cli/commands/embed.js')).embedCommand([]);
      else await (await import('../src/cli/commands/maintain.js')).maintainCommand(['--embed']);

      const reopened = openDb(process.env.ENGRAM_DB!);
      expect(reopened.prepare(`SELECT count(*) FROM embeddings WHERE target_id = 'orphan'`).pluck().get()).toBe(0);
      expect(reopened.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(1);
      reopened.close();
    },
  );

  it('Phase 6 review: unknown flag (typo --lmit) is a usage error, even with embedding disabled', () => {
    const r = runCli(['embed', '--lmit', '5'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: engram embed [--limit N]');
    expect(r.stderr).toContain('--lmit');
  });

  it('Phase 6 review: --limit with a bad value is rejected', () => {
    const r = runCli(['embed', '--limit', 'abc'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--limit');
  });

  it('Phase 6 re-review: maintain --embed loops to completion (600 > 500 per batch)', async () => {
    useDb(tmpDbFile());
    const fake = createFakeEmbedder();
    vi.doMock('../src/embed/load.js', () => ({
      tryLoadEmbedder: async () => ({ embedder: fake, reason: 'ok' }),
    }));
    const db = openDb(process.env.ENGRAM_DB!);
    for (let i = 0; i < 600; i++) appendEvent(db, { sessionId: 's', role: 'user', content: `event number ${i}` });
    db.close();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
    const { maintainCommand } = await import('../src/cli/commands/maintain.js');
    const status = await maintainCommand(['--embed']);
    spy.mockRestore();
    expect(status).toBe(0);
    expect(out.join('')).toContain('embedded 600');
    const reopened = openDb(process.env.ENGRAM_DB!);
    expect(reopened.prepare(`SELECT count(*) FROM embeddings`).pluck().get()).toBe(600);
    reopened.close();
  });

  it.each(['0', '0.5', '-3', '1.5'])('Phase 6 re-review: --limit %s is a usage error', (v) => {
    const r = runCli(['embed', '--limit', v], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--limit must be an integer >= 1');
    expect(r.stderr).toContain('usage: engram embed [--limit N]');
  });

  describe('embedCommand batching', () => {
    async function run(args: string[], events: number) {
      useDb(tmpDbFile());
      const fake = createFakeEmbedder();
      vi.doMock('../src/embed/load.js', () => ({
        tryLoadEmbedder: async () => ({ embedder: fake, reason: 'ok' }),
      }));
      const db = openDb(process.env.ENGRAM_DB!);
      for (let i = 0; i < events; i++) appendEvent(db, { sessionId: 's', role: 'user', content: `event number ${i}` });
      db.close();
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
      const { embedCommand } = await import('../src/cli/commands/embed.js');
      const status = await embedCommand(args);
      spy.mockRestore();
      const reopened = openDb(process.env.ENGRAM_DB!);
      const count = reopened.prepare(`SELECT count(*) FROM embeddings`).pluck().get() as number;
      reopened.close();
      return { status, count, out: out.join('') };
    }

    it('loops past the per-batch size until nothing is missing (600 > 500)', async () => {
      const r = await run([], 600);
      expect(r.status).toBe(0);
      expect(r.count).toBe(600);
      expect(r.out).toContain('embedded 600');
      expect(r.out).toContain('remaining 0');
    });

    it('--limit N caps the total embedded and reports the remaining count', async () => {
      const r = await run(['--limit', '7'], 20);
      expect(r.count).toBe(7);
      expect(r.out).toContain('embedded 7');
      expect(r.out).toContain('remaining 13');
    });
  });
});
