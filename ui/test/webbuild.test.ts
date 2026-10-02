import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web');
const built = fs.existsSync(path.join(root, 'index.html'));

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

describe.skipIf(!built)('built web app (needs `npm run build -w ui`)', () => {
  const html = built ? fs.readFileSync(path.join(root, 'index.html'), 'utf8') : '';

  it('index.html has no inline script or style and only relative assets', () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son\w+=/i);
    for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
      const url = m[1]!;
      if (url.startsWith('data:')) continue;
      expect(url, url).toMatch(/^\.\/assets\//);
      expect(fs.existsSync(path.join(root, url)), url).toBe(true);
    }
  });

  it('references no external host anywhere in the bundle', () => {
    for (const f of walk(root)) {
      if (/\.woff2?$/.test(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/fonts\.googleapis|gstatic/);
      if (f.endsWith('.html') || f.endsWith('.css')) expect(text, f).not.toMatch(/https?:\/\//);
    }
  });

  it('bundles the fonts as local files', () => {
    const css = fs.readdirSync(path.join(root, 'assets')).filter((f) => f.endsWith('.css'));
    const text = css.map((f) => fs.readFileSync(path.join(root, 'assets', f), 'utf8')).join('');
    expect(text).toContain('Newsreader Variable');
    expect(text).toContain('Schibsted Grotesk Variable');
    expect(text).toMatch(/url\(\.?\/?[^)]*\.woff2\)/);
  });
});
