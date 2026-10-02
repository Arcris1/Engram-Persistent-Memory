import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMcpRunner, defaultMcpRunnerAsync } from '../src/cli/commands/install.js';
import { ROOT, runCli, tmpDbFile, tmpDir } from './helpers.js';

/** A fake `claude` script in a temp dir (put `bin` on PATH). */
export function fakeClaude(body: string): { bin: string; dir: string } {
  const dir = tmpDir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { bin, dir };
}

describe('ENGRAM_SKIP_HOOKS (A1)', () => {
  const future = (): string => String(Date.now() + 60_000);
  for (const sub of ['ingest-prompt', 'ingest-transcript', 'session-start', 'session-end']) {
    it(`${sub} with a future expiry exits 0, prints nothing and never touches the DB`, () => {
      const dbFile = tmpDbFile();
      const stdin = JSON.stringify({ session_id: 'sess-skip', cwd: ROOT, transcript_path: '/dev/null', prompt: 'hello' });
      const r = runCli([sub], { dbFile, stdin, env: { ENGRAM_SKIP_HOOKS: future() } });
      expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
      expect(fs.existsSync(dbFile)).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(dbFile), 'spool'))).toBe(false);
    });
  }

  for (const [label, value] of [['a past timestamp', String(Date.now() - 1000)], ['1', '1'], ['garbage', 'abc']] as const) {
    it(`session-start runs normally when ENGRAM_SKIP_HOOKS is ${label}`, () => {
      const dbFile = tmpDbFile();
      const stdin = JSON.stringify({ session_id: 'sess-run', cwd: ROOT, source: 'startup' });
      const r = runCli(['session-start'], { dbFile, stdin, env: { ENGRAM_SKIP_HOOKS: value } });
      expect(r.status).toBe(0);
      expect(fs.existsSync(dbFile)).toBe(true);
    });
  }

  it('the sync and async mcp runners set ENGRAM_SKIP_HOOKS to an expiry (timeout + 5 s) for claude', async () => {
    const { bin, dir } = fakeClaude(`echo "skip=$ENGRAM_SKIP_HOOKS" > "$(dirname "$0")/../env.txt"`);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const out = path.join(dir, 'env.txt');
      const expiry = (): number => Number(fs.readFileSync(out, 'utf8').trim().replace('skip=', ''));
      let t = Date.now();
      defaultMcpRunner(['mcp', 'get', 'engram'], 7000);
      expect(expiry()).toBeGreaterThanOrEqual(t + 12_000);
      expect(expiry()).toBeLessThanOrEqual(Date.now() + 12_000);
      fs.rmSync(out);
      t = Date.now();
      await defaultMcpRunnerAsync(['mcp', 'get', 'engram'], 7000);
      expect(expiry()).toBeGreaterThanOrEqual(t + 12_000);
      expect(expiry()).toBeLessThanOrEqual(Date.now() + 12_000);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe('mcp timeouts and unavailable claude (A2, A4)', () => {
  const withPath = async (bin: string, fn: () => void | Promise<void>): Promise<void> => {
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      await fn();
    } finally {
      process.env.PATH = prev;
    }
  };

  it('doctor applies the 5s limit to `claude mcp get` (unavailable, not a hang)', async () => {
    const { bin } = fakeClaude('sleep 9');
    await withPath(bin, async () => {
      const { doctorReportAsync } = await import('../src/cli/commands/install.js');
      const t = Date.now();
      const r = await doctorReportAsync({ claudeDir: tmpDir() });
      expect(Date.now() - t).toBeLessThan(8000);
      expect(r.mcp.registered).toBe(false);
    });
  }, 15_000);

  it('install gives `claude mcp get` the long limit: a 6s answer is honoured and `add` still runs', async () => {
    const { bin, dir } = fakeClaude(
      `if [ "$2" = get ]; then sleep 6; echo "not found" >&2; exit 1; fi\necho added > "$(dirname "$0")/../added.txt"`,
    );
    await withPath(bin, async () => {
      const { doInstall } = await import('../src/cli/commands/install.js');
      const r = doInstall({ claudeDir: tmpDir(), execPath: process.execPath });
      expect(r.mcp.unavailable).toBeUndefined();
      expect(r.mcp.attempted).toBe(true);
      expect(fs.existsSync(path.join(dir, 'added.txt'))).toBe(true);
    });
  }, 20_000);

  for (const cmd of ['install', 'uninstall']) {
    it(`${cmd} with no claude on PATH reports an error and exits 1 (never "nothing to do"/add)`, () => {
      const empty = tmpDir();
      const r = runCli([cmd, '--claude-dir', tmpDir()], { dbFile: tmpDbFile(), env: { PATH: empty } });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('mcp:           error: claude did not answer');
      expect(r.stdout).not.toContain('nothing to do');
    });
  }

  it('the async runner caps collected output at 1 MiB per stream', async () => {
    const { bin } = fakeClaude('head -c 3000000 /dev/zero | tr "\\0" x; head -c 3000000 /dev/zero | tr "\\0" y >&2; exit 1');
    await withPath(bin, async () => {
      const r = await defaultMcpRunnerAsync(['mcp', 'get', 'x'], 10_000);
      expect(r.status).toBe(1);
      expect(r.stdout.length).toBeGreaterThan(0);
      expect(r.stdout.length).toBeLessThan(1024 * 1024 + 70_000);
      expect(r.stderr.length).toBeLessThan(1024 * 1024 + 70_000);
    });
  });

  it('a claude that cannot be started resolves with an error instead of throwing', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho hi\n', { mode: 0o644 });
    await withPath(dir, async () => {
      const r = await defaultMcpRunnerAsync(['mcp', 'get', 'x'], 3000);
      expect(r.status).toBe(1);
      expect(r.stderr).not.toBe('');
    });
    const r = await defaultMcpRunnerAsync(['mcp', 'get', 'x'], 3000).catch(() => null);
    expect(r).not.toBeNull();
  });

  it('the async runner does not inherit stdin (reads EOF at once)', async () => {
    const { bin } = fakeClaude('cat >/dev/null; echo done');
    await withPath(bin, async () => {
      const r = await defaultMcpRunnerAsync(['mcp', 'get', 'x'], 3000);
      expect(r).toMatchObject({ status: 0, stdout: 'done\n' });
    });
  });
});
