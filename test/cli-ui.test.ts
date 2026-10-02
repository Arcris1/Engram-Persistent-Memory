import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ROOT, runCli, tmpDbFile, tmpDir } from './helpers.js';

function fixtureEntry(body: string): string {
  const file = path.join(tmpDir(), 'fake-ui.mjs');
  fs.writeFileSync(file, body);
  return file;
}

describe('engram ui', () => {
  it('spawns the entry with the args passed through and returns its exit code', () => {
    const entry = fixtureEntry(`console.log(JSON.stringify(process.argv.slice(2))); process.exit(3);`);
    const r = runCli(['ui', '--port', '4999', '--no-open'], { dbFile: tmpDbFile(), env: { ENGRAM_UI_ENTRY: entry } });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout.trim())).toEqual(['--port', '4999', '--no-open']);
  });

  it('exits 0 when the entry ends normally', () => {
    const entry = fixtureEntry(`process.exit(0);`);
    expect(runCli(['ui'], { dbFile: tmpDbFile(), env: { ENGRAM_UI_ENTRY: entry } }).status).toBe(0);
  });

  it('treats a child that ends on SIGINT as a normal stop (exit 0)', () => {
    const entry = fixtureEntry(`process.kill(process.pid, 'SIGINT'); setTimeout(() => {}, 5000);`);
    expect(runCli(['ui'], { dbFile: tmpDbFile(), env: { ENGRAM_UI_ENTRY: entry } }).status).toBe(0);
  });

  it('forwards SIGINT sent to the parent only (kill -INT <parent>) to the child; exit 0', async () => {
    const marker = path.join(tmpDir(), 'got-sigint');
    const entry = fixtureEntry(
      `import fs from 'node:fs'; process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(0); }); console.log('ready'); setTimeout(() => {}, 20000);`,
    );
    const parent = spawn(process.execPath, [path.join(ROOT, 'bin/engram.js'), 'ui'], {
      env: { ...process.env, ENGRAM_DB: tmpDbFile(), ENGRAM_UI_ENTRY: entry },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve) => parent.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve()));
    parent.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => parent.on('close', (c) => resolve(c)));
    expect(code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  }, 15_000);

  it('with the entry missing: exit 1 and the "not built" message', () => {
    const r = runCli(['ui'], { dbFile: tmpDbFile(), env: { ENGRAM_UI_ENTRY: path.join(tmpDir(), 'nope.js') } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`engram: the UI is not built; run 'npm run build' in ${ROOT}`);
  });

  it('lists ui in the usage text', () => {
    expect(runCli(['--help'], { dbFile: tmpDbFile() }).stdout).toContain('ui [--port N] [--no-open]');
  });

  it('src/cli/commands/ui.ts imports only node:child_process among network-adjacent modules', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'commands', 'ui.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['node:child_process', 'node:fs', 'node:path', 'node:url']);
  });
});
