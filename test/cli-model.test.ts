import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, tmpDbFile } from './helpers.js';

describe('engram model', () => {
  it('rejects an unknown subcommand', () => {
    const r = runCli(['model', 'frobnicate'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown 'model' subcommand 'frobnicate'");
  });

  it('rejects a missing subcommand', () => {
    const r = runCli(['model'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: engram model verify');
  });

  it('verify: rejects unknown flags / extra args with a usage error (exit 1, before loading anything)', () => {
    for (const extra of ['--bogus', 'extra']) {
      const r = runCli(['model', 'verify', extra], { dbFile: tmpDbFile() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`model verify: unknown argument '${extra}'`);
      expect(r.stderr).toContain('usage: engram model verify');
      expect(r.stdout).toBe('');
    }
  });

  it('verify: embedding disabled (the default) -> prints the reason, exits 1', () => {
    const r = runCli(['model', 'verify'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('disabled');
  });

  it('verify: enabled but misconfigured -> prints the specific reason, exits 1', () => {
    const dbFile = tmpDbFile();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(dbFile), 'config.json'),
      JSON.stringify({ embedding: { enabled: true, modelDir: '/does/not/exist', sha256: 'a'.repeat(64) } }),
    );
    const r = runCli(['model', 'verify'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('missing model file');
  });
});
