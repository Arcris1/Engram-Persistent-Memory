import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doInstall } from '../../dist/cli/commands/install.js';
import { setPaused } from '../../dist/control/pause.js';
import type { Health } from '../server/types.js';
import { addClaim, addEvent, start, tmpDir, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  setPaused(false);
  await h?.close();
  h = undefined;
});

const LABELS = ['When a session starts', 'When you send a message', 'When Claude replies', 'Before context is compacted', 'When a session ends'];

describe('GET /api/health', () => {
  it('lists hooks with plain labels, storage fields, and the newest backup (null, then set)', async () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true });
    h = await start({ doctorOpts: { claudeDir, noMcp: true }, seed: (db) => (addClaim(db), addEvent(db)) });
    const r = await h.req('/api/health');
    expect(r.status).toBe(200);
    const body = r.json<Health>();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.paused).toBe(false);
    expect(body.stats.claims.active).toBe(1);
    expect(body.hooks.map((x) => x.label).sort()).toEqual([...LABELS].sort());
    expect(body.hooks.every((x) => x.ok && x.problem === null)).toBe(true);
    expect(body.waiting).toBe(0);
    expect(body.memoryTools).toEqual({ checked: false, ok: false, detail: '' }); // skipped: noMcp
    expect(body.search).toEqual({ semantic: false, embedded: 0 });
    expect(body.hookErrors).toEqual({ last24h: 0 });
    expect(body.storage.path).toBe(h.dbFile);
    expect(body.storage.bytes).toBeGreaterThan(0);
    expect(body.storage.ownerOnly).toBe(true);
    expect(body.storage.schema).toBe(body.stats.schema_version);
    expect(body.storage.newestBackup).toBeNull();

    fs.writeFileSync(path.join(h.dir, 'backup-20260101000000.db'), 'x');
    const again = (await h.req('/api/health')).json<Health>();
    expect(again.storage.newestBackup).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports a missing hook with a problem, and loose file permissions', async () => {
    h = await start({ doctorOpts: { claudeDir: tmpDir(), noMcp: true } });
    fs.chmodSync(h.dbFile, 0o644);
    const body = (await h.req('/api/health')).json<Health>();
    expect(body.hooks).toHaveLength(5);
    expect(body.hooks.every((x) => !x.ok && x.problem === 'not installed')).toBe(true);
    expect(body.storage.ownerOnly).toBe(false);
  });

  it('a hook whose Node path merely differs from the running one is still ok', async () => {
    const claudeDir = tmpDir();
    const other = path.join(tmpDir(), 'node');
    fs.symlinkSync(process.execPath, other);
    doInstall({ claudeDir, noMcp: true, execPath: other });
    h = await start({ doctorOpts: { claudeDir, noMcp: true } });
    const body = (await h.req('/api/health')).json<Health>();
    expect(body.hooks.every((x) => x.ok && x.problem === null)).toBe(true);
  });

  it('reflects paused live even while the doctor report is cached', async () => {
    h = await start({ doctorOpts: { claudeDir: tmpDir(), noMcp: true } });
    expect((await h.req('/api/health')).json<Health>().paused).toBe(false);
    setPaused(true);
    expect((await h.req('/api/health')).json<Health>().paused).toBe(true);
  });

  it('degrades instead of failing when the settings file is unreadable', async () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{not json');
    h = await start({ doctorOpts: { claudeDir, noMcp: true } });
    const r = await h.req('/api/health');
    expect(r.status).toBe(200);
    expect(r.json<Health>().hooks.every((x) => !x.ok)).toBe(true);
  });

  it('answers on an empty database', async () => {
    h = await start({ doctorOpts: { claudeDir: tmpDir(), noMcp: true } });
    expect((await h.req('/api/health')).status).toBe(200);
  });

  it('a missing claude is reported as not checked, with a plain reason', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = tmpDir(); // no `claude` here
    try {
      h = await start({ doctorOpts: { claudeDir: tmpDir() } });
      const body = (await h.req('/api/health')).json<Health>();
      expect(body.memoryTools).toEqual({ checked: false, ok: false, detail: 'Claude Code did not answer.' });
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('runs the claude check once for concurrent requests, without blocking other requests', async () => {
    const bin = tmpDir();
    const log = path.join(bin, 'calls.log');
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho call >> "${log}"\nsleep 1\necho "engram:"; echo "  Command: node /x/dist/mcp.js"\n`, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath ?? ''}`;
    try {
      h = await start({ doctorOpts: { claudeDir: tmpDir() } });
      const slow = [h.req('/api/health'), h.req('/api/health'), h.req('/api/health')];
      await new Promise((r) => setTimeout(r, 150));
      const t0 = Date.now();
      expect((await h.req('/api/overview')).status).toBe(200); // answered while the check is still running
      expect(Date.now() - t0).toBeLessThan(500);
      const bodies = (await Promise.all(slow)).map((r) => r.json<Health>());
      expect(bodies.every((b) => b.memoryTools.ok && b.memoryTools.checked)).toBe(true);
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
