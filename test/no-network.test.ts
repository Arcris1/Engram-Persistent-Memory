import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, tmpDir } from './helpers.js';

const run = (...args: string[]) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-no-network.mjs'), ...args], { encoding: 'utf8' });

describe('check-no-network (§9.4)', () => {
  it('passes on src/', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each([
    `import http from 'node:http';`,
    `import { request } from "https";`,
    `const net = await import('net');`,
    `await fetch('https://example.com');`,
    `const ws = new WebSocket(url);`,
  ])('fails on: %s', (line) => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'bad.ts'), `${line}\n`);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bad.ts:1');
  });
});
