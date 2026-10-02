import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addClaim, addEvent, start, tmpDir, type Harness } from './helpers.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/web');
const built = fs.existsSync(path.join(WEB, 'index.html'));
if (!built) console.warn('e2e: ui/dist/web/index.html not found - run `npm run build` first; the end-to-end tests are skipped.');

const MIME: Record<string, RegExp> = {
  '.js': /^text\/javascript/,
  '.css': /^text\/css/,
  '.woff2': /^font\/woff2$/,
  '.woff': /^font\/woff$/,
  '.svg': /^image\/svg\+xml$/,
  '.png': /^image\/png$/,
  '.ico': /^image\/x-icon$/,
  '.json': /^application\/json/,
};

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Local URLs an HTML or CSS text refers to (src, href, url(...)), as absolute paths resolved against `base`. */
function refs(text: string, base: string, pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(pattern)) {
    const raw = (m[1] ?? m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    out.add(new URL(raw, `http://localhost${base}`).pathname);
  }
  return [...out];
}

describe.skipIf(!built)('built UI served by the real server', () => {
  it('serves index.html with the CSP, every asset and font with its MIME type, and the API with the token', async () => {
    h = await start({ webRoot: WEB, doctorOpts: { claudeDir: tmpDir(), noMcp: true }, seed: (db) => (addClaim(db), addEvent(db)) });
    const all: Awaited<ReturnType<Harness['req']>>[] = [];
    const get = async (p: string, token: string | null = null): Promise<Awaited<ReturnType<Harness['req']>>> => {
      const r = await h!.req(p, { token });
      all.push(r);
      return r;
    };

    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toMatch(/^text\/html/);
    expect(index.headers['content-security-policy']).toBeTruthy();
    expect(index.body).toBe(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'));

    const assets = refs(index.body, '/', /(?:src|href)="([^"]+)"/g).filter((u) => u !== '/');
    expect(assets.some((a) => a.endsWith('.js'))).toBe(true);
    expect(assets.some((a) => a.endsWith('.css'))).toBe(true);
    const fonts: string[] = [];
    for (const a of assets) {
      if (a.endsWith('.css')) fonts.push(...refs(fs.readFileSync(path.join(WEB, a), 'utf8'), a, /url\(([^)]+)\)/g));
    }
    expect(fonts.length).toBeGreaterThan(0);
    for (const url of [...assets, ...fonts]) {
      const r = await get(url);
      const ext = path.extname(url);
      expect(r.status, url).toBe(200);
      expect(r.headers['content-type'], url).toMatch(MIME[ext] ?? /./);
      expect(r.headers['content-security-policy'], url).toBeTruthy();
      // the file itself, not the index.html fallback
      expect(r.body.startsWith('<!doctype') || r.body.startsWith('<!DOCTYPE'), url).toBe(false);
    }

    for (const api of ['/api/overview', '/api/health']) {
      const r = await get(api, h.server.token);
      expect(r.status, api).toBe(200);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
    }
    expect((await get('/api/overview')).status).toBe(401);

    for (const r of all) expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('answers an Origin from another site without CORS headers', async () => {
    h = await start({ webRoot: WEB });
    const r = await h.req('/api/overview', { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });
});
