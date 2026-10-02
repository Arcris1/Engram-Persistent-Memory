import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMcpRunner, defaultMcpRunnerAsync, doDoctor, doInstall, doctorReport, doctorReportAsync, formatDoctorReport } from '../src/cli/commands/install.js';
import { HOOK_EVENTS } from '../src/install/settings.js';
import { appendEvent } from '../src/events/events.js';
import { openDb } from '../src/storage/db.js';
import { tmpDbFile, tmpDir } from './helpers.js';

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

describe('doctorReport', () => {
  it('with no database: exists false, stats null, and no database is created', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const claudeDir = tmpDir();
    const r = doctorReport({ claudeDir, noMcp: true });
    expect(r.db).toEqual({ path: dbFile, exists: false, stats: null });
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(r.mcp).toEqual({ checked: false, registered: false, detail: 'skipped (--no-mcp)' });
    expect(r.claudeMd).toEqual({ path: path.join(claudeDir, 'CLAUDE.md'), installed: false });
    expect(r.spool).toEqual({ backlog: 0, bad: 0, badFiles: [] });
    expect(r.hookErrors).toEqual({ path: path.join(path.dirname(dbFile), 'hooks.log'), last24h: 0, lastLines: [] });
  });

  it('with a database: stats are filled in', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const db = openDb(dbFile);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'hello there' });
    db.close();
    const r = doctorReport({ claudeDir: tmpDir(), noMcp: true });
    expect(r.db.exists).toBe(true);
    expect(r.db.stats?.events).toBe(1);
  });

  it('missing hooks: every event listed, none installed, no diagnostics', () => {
    useDb(tmpDbFile());
    const r = doctorReport({ claudeDir: tmpDir(), noMcp: true });
    expect(r.hooks.map((h) => h.event)).toEqual(Object.keys(HOOK_EVENTS));
    for (const h of r.hooks) expect(h).toEqual({ event: h.event, installed: false, node: null, root: null, nativeModule: null, detail: null });
  });

  it('installed hooks: node/root/nativeModule diagnosed', () => {
    useDb(tmpDbFile());
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true });
    const r = doctorReport({ claudeDir, noMcp: true });
    expect(r.claudeMd.installed).toBe(true);
    for (const h of r.hooks) expect(h).toEqual({ event: h.event, installed: true, node: 'ok', root: 'ok', nativeModule: 'ok', detail: null });
  });

  it('installed hooks with an unusable node binary: node missing, no native module check', () => {
    useDb(tmpDbFile());
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: '/no/such/node-binary' });
    const r = doctorReport({ claudeDir, noMcp: true });
    for (const h of r.hooks) expect(h).toMatchObject({ installed: true, node: 'missing', root: 'ok', nativeModule: null });
  });

  it('mcp: runner output maps to checked/registered/detail', () => {
    useDb(tmpDbFile());
    const claudeDir = tmpDir();
    const runner = (stdout: string, status = 0) => () => ({ status, stdout, stderr: '' });
    expect(doctorReport({ claudeDir, mcpRunner: runner('engram:\n  Command: node /x/dist/mcp.js\n') }).mcp).toEqual({
      checked: true,
      registered: true,
      detail: 'engram:',
    });
    expect(doctorReport({ claudeDir, mcpRunner: runner('engram:\n  Command: other\n') }).mcp).toMatchObject({ checked: true, registered: false });
  });

  it('spool and hooks.log are reported', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const data = path.dirname(dbFile);
    fs.mkdirSync(path.join(data, 'spool'), { recursive: true });
    fs.writeFileSync(path.join(data, 'spool', 'a.json'), '{}');
    fs.writeFileSync(path.join(data, 'spool', 'b.json'), '{}');
    fs.writeFileSync(path.join(data, 'spool', 'z.bad'), 'x');
    fs.writeFileSync(path.join(data, 'hooks.log'), `${new Date().toISOString()} SqliteError: boom\nplain line\n`);
    const r = doctorReport({ claudeDir: tmpDir(), noMcp: true });
    expect(r.spool).toEqual({ backlog: 2, bad: 1, badFiles: ['z.bad'] });
    expect(r.hookErrors.last24h).toBe(1);
    expect(r.hookErrors.lastLines).toHaveLength(2);
  });
});

describe('doDoctor is the formatter applied to doctorReport', () => {
  it('produces identical text', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const db = openDb(dbFile);
    appendEvent(db, { sessionId: 's', role: 'user', content: 'hello there' });
    db.close();
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true });
    const opts = { claudeDir, noMcp: true };
    expect(doDoctor(opts)).toBe(formatDoctorReport(doctorReport(opts), claudeDir));
  });
});

describe('claude mcp get that hangs or is missing', () => {
  const COULD_NOT = { checked: false, registered: false, detail: 'could not check (claude did not answer in time, or is not installed)' };
  let prevPath: string | undefined;
  afterEach(() => {
    if (prevPath !== undefined) process.env.PATH = prevPath;
    prevPath = undefined;
  });
  function fakeClaude(script: string): void {
    const bin = tmpDir();
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath ?? ''}`;
  }

  it('a hung claude times out quickly and is reported as could-not-check', () => {
    fakeClaude('sleep 5');
    const t0 = Date.now();
    const r = defaultMcpRunner(['mcp', 'get', 'engram'], 200);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r).toMatchObject({ unavailable: true });
    useDb(tmpDbFile());
    expect(doctorReport({ claudeDir: tmpDir(), mcpRunner: () => r }).mcp).toEqual(COULD_NOT);
  });

  it('a missing claude is could-not-check too', () => {
    prevPath = process.env.PATH;
    process.env.PATH = tmpDir();
    const r = defaultMcpRunner(['mcp', 'get', 'engram'], 200);
    expect(r).toMatchObject({ unavailable: true });
  });

  it('claude does not inherit this process\'s stderr and a normal answer still maps as before', () => {
    fakeClaude('echo "engram:"; echo "  Command: node /x/dist/mcp.js"; echo noise >&2');
    const r = defaultMcpRunner(['mcp', 'get', 'engram']);
    expect(r).toMatchObject({ status: 0 });
    expect(r.stdout).toContain('dist/mcp.js');
    expect(r.unavailable).toBeUndefined();
  });

  it('the async report does not block the event loop and reports a hung claude as could-not-check', async () => {
    fakeClaude('sleep 5');
    useDb(tmpDbFile());
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const r = await doctorReportAsync({ claudeDir: tmpDir() }, 300);
    clearInterval(timer);
    expect(r.mcp).toEqual(COULD_NOT);
    expect(ticks).toBeGreaterThan(3);
  });
});
