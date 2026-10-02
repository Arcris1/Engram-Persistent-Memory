import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js');

describe('ui/dist/main.js startup errors', () => {
  it.skipIf(!fs.existsSync(main))('a relative ENGRAM_DB: one "engram ui: ..." line, exit 1, no stack trace', () => {
    const r = spawnSync(process.execPath, [main, '--no-open'], { env: { ...process.env, ENGRAM_DB: 'relative/path' }, encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^engram ui: .*absolute path.*\n$/);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).not.toContain('    at ');
  });
});
