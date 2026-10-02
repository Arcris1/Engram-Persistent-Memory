import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'demo.mjs');
const built = fs.existsSync(path.join(path.dirname(script), '..', 'dist', 'web', 'index.html'));

describe('ui/scripts/demo.mjs', () => {
  it.skipIf(!built)('removes its temp dir when startup fails after the dir was created', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-demo-test-'));
    try {
      const r = spawnSync(process.execPath, [script, '--no-open', '--port', '70000'], { env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8', timeout: 15_000 });
      expect(r.status).toBe(1);
      expect(fs.readdirSync(tmp).filter((n) => n.startsWith('engram-ui-demo-'))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it.skipIf(!built)(`exits 0 and removes its temp dir on ${sig}; Health never runs claude or reads ~/.claude`, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-demo-test-'));
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      const marker = path.join(tmp, 'claude-ran');
      fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
      const child = spawn(process.execPath, [script, '--no-open'], {
        env: { ...process.env, TMPDIR: tmp, PATH: `${bin}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      try {
        let out = '';
        await new Promise<void>((resolve) =>
          child.stdout.on('data', (d: Buffer) => {
            out += d.toString();
            if (/#token=/.test(out)) resolve();
          }),
        );
        const m = /http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+)/.exec(out)!;
        const res = await fetch(`http://127.0.0.1:${m[1]}/api/health`, { headers: { authorization: `Bearer ${m[2]}` } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { hooks: { ok: boolean }[]; memoryTools: { checked: boolean } };
        expect(body.hooks).toHaveLength(5);
        expect(body.hooks.every((x) => x.ok)).toBe(true);
        expect(body.memoryTools.checked).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
        child.kill(sig);
        const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
        expect(code).toBe(0);
        expect(fs.readdirSync(tmp).filter((n) => n.startsWith('engram-ui-demo-'))).toEqual([]);
      } finally {
        child.kill('SIGKILL');
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
