import fs from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticResult {
  status: number;
  type: string;
  body: Buffer | string;
}

/** The file for `rel` when it is a regular file that really lives under `root` (symlinks resolved), else undefined. */
function readInside(root: string, rel: string): Buffer | undefined {
  const full = path.resolve(root, `.${path.sep}${rel}`);
  if (full !== root && !full.startsWith(root + path.sep)) return undefined;
  try {
    const real = fs.realpathSync(full);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return undefined;
    return fs.readFileSync(real);
  } catch {
    return undefined;
  }
}

/** Resolves a URL path against `webRoot`; unknown paths get index.html (client-side routes), 503 when it is missing. */
export function resolveStatic(webRoot: string, urlPath: string): StaticResult {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 400, type: MIME['.txt']!, body: 'bad request' };
  }
  if (decoded.includes('\0')) return { status: 400, type: MIME['.txt']!, body: 'bad request' };
  let root: string;
  try {
    root = fs.realpathSync(webRoot);
  } catch {
    return { status: 503, type: MIME['.txt']!, body: 'the web app is not built' };
  }
  const rel = decoded.replace(/^\/+/, '');
  const escapes = rel.split(/[\\/]/).includes('..');
  if (rel !== '' && !escapes) {
    const file = readInside(root, rel);
    if (file) return { status: 200, type: MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream', body: file };
  }
  if (escapes) return { status: 404, type: MIME['.txt']!, body: 'not found' };
  const index = readInside(root, 'index.html');
  if (!index) return { status: 503, type: MIME['.txt']!, body: 'the web app is not built' };
  return { status: 200, type: MIME['.html']!, body: index };
}
