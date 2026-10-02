import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, startServer } from '../server/http.js';
import { addClaim, rawRequest, start, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

function expectSecurityHeaders(headers: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(HEADERS)) expect(headers[k]).toBe(v);
  expect(headers['access-control-allow-origin']).toBeUndefined();
}

function makeWeb(h: Harness): void {
  fs.mkdirSync(path.join(h.webRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(h.webRoot, 'index.html'), '<!doctype html><title>engram</title>');
  fs.writeFileSync(path.join(h.webRoot, 'assets', 'app.js'), 'export {};');
  fs.writeFileSync(path.join(h.webRoot, 'assets', 'app.css'), 'body{}');
}

describe('server shell and token auth', () => {
  it('binds 127.0.0.1 only and builds a launch URL carrying the token', async () => {
    h = await start();
    const probe = await new Promise<string>((resolve, reject) => {
      const s = net.connect(h!.server.port, '127.0.0.1', () => {
        resolve(s.remoteAddress ?? '');
        s.destroy();
      });
      s.on('error', reject);
    });
    expect(probe).toBe('127.0.0.1');
    expect(h.server.url).toBe(`http://127.0.0.1:${h.server.port}/#token=${h.server.token}`);
    expect(h.server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is not reachable on a non-loopback interface address', async () => {
    h = await start();
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!lan) return; // no external interface on this machine: nothing to probe
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect(h!.server.port, lan.address);
      s.on('connect', () => (s.destroy(), resolve(false)));
      s.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('401 without a token, with a wrong token, with a wrong scheme', async () => {
    h = await start();
    const cases: Record<string, string>[] = [{}, { authorization: 'Bearer nope' }, { authorization: `Basic ${h.server.token}` }, { authorization: `Bearer ${h.server.token}x` }];
    for (const headers of cases) {
      const r = await h.req('/api/overview', { token: null, headers });
      expect(r.status).toBe(401);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    }
    expect((await h.req('/api/overview')).status).toBe(200);
  });

  it('403 for a wrong Host and for a foreign or null Origin', async () => {
    h = await start();
    const bad = await h.req('/api/overview', { headers: { host: 'evil.example:80' } });
    expect(bad.status).toBe(403);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    expect((await h.req('/api/overview', { headers: { host: `127.0.0.1:${h.server.port + 1}` } })).status).toBe(403);
    expect((await h.req('/api/overview', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await h.req('/api/overview', { headers: { origin: 'null' } })).status).toBe(403);
    expect((await h.req('/', { headers: { host: 'evil.example' } })).status).toBe(403);
    // the two allowed hosts and origins
    const p = h.server.port;
    expect((await h.req('/api/overview', { headers: { host: `localhost:${p}`, origin: `http://localhost:${p}` } })).status).toBe(200);
    expect((await h.req('/api/overview', { headers: { host: `127.0.0.1:${p}`, origin: `http://127.0.0.1:${p}` } })).status).toBe(200);
  });

  it('404 for an unknown API path, 405 for a non-GET on a read route', async () => {
    h = await start();
    const r = await h.req('/api/x');
    expect(r.status).toBe(404);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('not_found');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const m = await h.req('/api/overview', { method });
      expect(m.status).toBe(405);
      expect(m.headers.allow).toBe('GET');
    }
    expect((await h.req('/api/memories/abc', { method: 'POST' })).status).toBe(405);
  });

  it('sends the security headers on API, error and static responses; no-store on the API', async () => {
    h = await start();
    makeWeb(h);
    const ok = await h.req('/api/overview');
    expectSecurityHeaders(ok.headers);
    expect(ok.headers['cache-control']).toBe('no-store');
    for (const r of [
      await h.req('/api/overview', { token: null }),
      await h.req('/api/x'),
      await h.req('/api/overview', { method: 'POST' }),
      await h.req('/', { headers: { host: 'evil.example' } }),
      await h.req('/', { token: null }),
      await h.req('/assets/app.js', { token: null }),
      await h.req('/no/such/page', { token: null }),
      await h.req('/%zz', { token: null }),
    ]) {
      expectSecurityHeaders(r.headers);
    }
    expect((await h.req('/api/overview', { token: null })).headers['cache-control']).toBe('no-store');
  });

  it('answers 503 with the headers when the web app is not built', async () => {
    h = await start();
    const r = await h.req('/', { token: null });
    expect(r.status).toBe(503);
    expect(r.body).toContain('the web app is not built');
    expectSecurityHeaders(r.headers);
  });

  it('falls back to the next free port when the base port is taken', async () => {
    h = await start();
    const taken = h.server.port;
    const second = await startServer({ db: h.db, dbFile: h.dbFile, port: taken, webRoot: h.webRoot });
    try {
      expect(second.port).toBeGreaterThan(taken);
      expect(second.port).toBeLessThanOrEqual(taken + 10);
      expect((await rawRequest(second.port, '/api/overview', { headers: { authorization: `Bearer ${second.token}` } })).status).toBe(200);
    } finally {
      await second.close();
    }
  });

  it('refuses with a clear message when no port in the range is free', async () => {
    h = await start();
    const taken = h.server.port;
    const servers = [];
    try {
      for (let i = 1; i <= 10; i++) {
        try {
          servers.push(await startServer({ db: h.db, dbFile: h.dbFile, port: taken + i, webRoot: h.webRoot }));
        } catch {
          /* that port was already used by something else: fine, it is still taken */
        }
      }
      await expect(startServer({ db: h.db, dbFile: h.dbFile, port: taken, webRoot: h.webRoot })).rejects.toThrow(/no free port/);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });
});

describe('hardening', () => {
  /** Raw bytes in, raw response text out (the socket is closed by the server). */
  function raw(port: number, bytes: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
      let out = '';
      s.on('data', (d) => (out += d.toString('latin1')));
      s.on('close', () => resolve(out));
      s.on('error', reject);
      setTimeout(() => s.destroy(), 3000);
    });
  }
  const headerOf = (resp: string, name: string): string | undefined => new RegExp(`^${name}: (.*)\\r$`, 'im').exec(resp)?.[1];
  const logs = (): { restore(): string } => {
    const out: string[] = [];
    const w1 = process.stdout.write.bind(process.stdout);
    const w2 = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stderr.write;
    return {
      restore: () => {
        process.stdout.write = w1;
        process.stderr.write = w2;
        return out.join('');
      },
    };
  };

  it('a malformed request URL answers 400 bad_request and logs nothing', async () => {
    h = await start();
    const cap = logs();
    let resp = '';
    try {
      resp = await raw(h.server.port, `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${h.server.port}\r\nConnection: close\r\n\r\n`);
    } finally {
      expect(cap.restore()).toBe('');
    }
    expect(resp).toMatch(/^HTTP\/1\.1 400 /);
    expect(resp).toContain('"bad_request"');
    expect(headerOf(resp, 'x-content-type-options')).toBe('nosniff');
  });

  it('parser-level errors (oversized header, bad method, missing Host) answer with the security headers and no detail', async () => {
    h = await start();
    const port = h.server.port;
    const cases: [string, string, RegExp][] = [
      ['oversized header', `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`, /^HTTP\/1\.1 431 /],
      ['bad method', `FO@O / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, /^HTTP\/1\.1 400 /],
      ['missing Host', 'GET /api/overview HTTP/1.1\r\n\r\n', /^HTTP\/1\.1 (400|403) /],
    ];
    for (const [name, bytes, status] of cases) {
      const resp = await raw(port, bytes);
      expect(resp, name).toMatch(status);
      expect(headerOf(resp, 'content-security-policy'), name).toContain("default-src 'none'");
      expect(headerOf(resp, 'x-frame-options'), name).toBe('DENY');
      const body = resp.split('\r\n\r\n')[1] ?? '';
      expect(body.length, name).toBeLessThan(80);
    }
  });

  it('sets conservative explicit parser limits', () => {
    expect(LIMITS.maxHeaderSize).toBeLessThanOrEqual(16 * 1024);
    expect(LIMITS.headersTimeout).toBeLessThanOrEqual(30_000);
    expect(LIMITS.requestTimeout).toBeLessThanOrEqual(60_000);
    expect(LIMITS.headersTimeout).toBeLessThanOrEqual(LIMITS.requestTimeout);
  });

  it('never tries a port above 65535', async () => {
    h = await start();
    const blocker = net.createServer();
    const held = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false));
      blocker.listen(65535, '127.0.0.1', () => resolve(true));
    });
    try {
      if (!held) return; // 65535 is in use by something else: the same path is exercised
      await expect(startServer({ db: h.db, dbFile: h.dbFile, port: 65535, webRoot: h.webRoot })).rejects.toThrow(/no free port/);
    } finally {
      blocker.close();
    }
  });
});

describe('static serving', () => {
  it('serves files with the fixed MIME table and index.html for unknown paths', async () => {
    h = await start();
    makeWeb(h);
    const idx = await h.req('/', { token: null });
    expect(idx.status).toBe(200);
    expect(idx.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(idx.body).toContain('<title>engram</title>');
    const js = await h.req('/assets/app.js', { token: null });
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await h.req('/assets/app.css', { token: null })).headers['content-type']).toBe('text/css; charset=utf-8');
    const spa = await h.req('/memories/whatever', { token: null });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('<title>engram</title>');
    expect((await h.req('/', { token: null, method: 'POST' })).status).toBe(405);
  });

  it('never serves a file outside webRoot (plain and encoded traversal)', async () => {
    h = await start();
    makeWeb(h);
    fs.writeFileSync(path.join(h.dir, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    for (const p of ['/../secret.txt', '/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/..\\secret.txt', '/%00']) {
      const r = await h.req(p, { token: null });
      expect(r.body).not.toContain('TOP-SECRET-OUTSIDE');
      expect([200, 400, 404]).toContain(r.status);
    }
  });

  it('does not follow a symlink that leaves webRoot', async () => {
    h = await start();
    makeWeb(h);
    fs.writeFileSync(path.join(h.dir, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    fs.symlinkSync(path.join(h.dir, 'secret.txt'), path.join(h.webRoot, 'link.txt'));
    const r = await h.req('/link.txt', { token: null });
    expect(r.body).not.toContain('TOP-SECRET-OUTSIDE');
  });
});

describe('quiet logging', () => {
  it('writes neither memory content nor the token to stdout/stderr', async () => {
    const out: string[] = [];
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => (out.push(String(c)), true)) as typeof process.stderr.write;
    try {
      h = await start({ seed: (db) => addClaim(db, { statement: 'ZEBRA-CONTENT-MARKER likes quiet' }) });
      await h.req('/api/overview');
      await h.req('/api/memories?q=ZEBRA-CONTENT-MARKER&kind=messages');
      await h.req('/api/memories/no-such-id');
      await h.req('/api/overview', { token: 'wrong' });
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
    const all = out.join('');
    expect(all).not.toContain('ZEBRA-CONTENT-MARKER');
    expect(all).not.toContain(h!.server.token);
  });
});
