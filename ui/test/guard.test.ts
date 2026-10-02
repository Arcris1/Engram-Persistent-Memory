import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(script: string, arg?: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...(arg ? [arg] : [])], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

/** A throwaway ui/ tree holding one file, to prove the guard really fails. */
function fixture(file: string, text: string): string {
  const dir = tmpDir();
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

describe('network guards', () => {
  it('the UI package is clean (server and, when present, web/src)', () => {
    const r = run('check-ui-network.mjs');
    expect(r.out).toContain('ok');
    expect(r.status).toBe(0);
  });

  it('the core src/ guard still passes unchanged', () => {
    const r = run('check-no-network.mjs');
    expect(r.out).toContain('no network use');
    expect(r.status).toBe(0);
  });

  it('allows node:http in the server but nothing else network-shaped, and no fetch(', () => {
    expect(run('check-ui-network.mjs', fixture('server/a.ts', "import http from 'node:http';\n")).status).toBe(0);
    for (const line of ["import https from 'node:https';", "import net from 'node:net';", "import h2 from 'node:http2';", "const x = await import('node:tls');", 'await fetch(url);', "import u from 'undici';"]) {
      const r = run('check-ui-network.mjs', fixture('server/a.ts', `${line}\n`));
      expect(r.status, line).toBe(1);
    }
  });

  it('forbids outbound node:http use and bare side-effect network imports in the server', () => {
    const bad = [
      "import http from 'node:http';\nhttp.request('http://x');",
      "import http from 'node:http';\nhttp.get(url, cb);",
      "import * as h from 'node:http';\nh.request(opts);",
      "import nodeHttp from 'node:http';\nnodeHttp.get(u);",
      "import { request } from 'node:http';",
      "import { createServer, get as g } from 'node:http';",
      "import 'node:net';",
      "import 'node:tls';",
    ];
    for (const text of bad) expect(run('check-ui-network.mjs', fixture('server/a.ts', `${text}\n`)).status, text).toBe(1);
    // serving is fine, and an unrelated Map.get is not an outbound call
    const ok = "import http from 'node:http';\nimport { createServer } from 'node:http';\nconst m = new Map();\nm.get(1);\nhttp.createServer(() => {});\n";
    expect(run('check-ui-network.mjs', fixture('server/a.ts', ok)).status).toBe(0);
  });

  it('allows fetch( only in web/src/api.ts, and forbids URLs and raw HTML in web/src', () => {
    expect(run('check-ui-network.mjs', fixture('web/src/api.ts', 'const r = await fetch("/api/x");\n')).status).toBe(0);
    expect(run('check-ui-network.mjs', fixture('web/src/other.ts', 'fetch("/api/x");\n')).status).toBe(1);
    expect(run('check-ui-network.mjs', fixture('web/src/a.ts', 'const u = "https://example.com";\n')).status).toBe(1);
    expect(run('check-ui-network.mjs', fixture('web/src/A.vue', '<div v-html="x"></div>\n')).status).toBe(1);
    expect(run('check-ui-network.mjs', fixture('web/src/a.ts', 'el.innerHTML = x;\n')).status).toBe(1);
  });
});
