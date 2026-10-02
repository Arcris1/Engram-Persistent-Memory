#!/usr/bin/env node
// Companion to check-no-network.mjs for the UI package (DECISIONS D45): the server may import
// node:http and nothing else network-shaped; the web app may call fetch() only from api.ts and carries
// no absolute URL and no raw-HTML rendering. Usage: check-ui-network.mjs [<ui dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'ui');

// node:http is the one network module the UI server is allowed, so it is left out of this list.
const NET_MODULES = '(?:node:)?(?:https|http2|net|tls|dgram)';
const SERVER_FORBIDDEN = [
  new RegExp(`from\\s+['"]${NET_MODULES}['"]`),
  new RegExp(`import\\(\\s*['"]${NET_MODULES}['"]\\s*\\)`),
  new RegExp(`require\\(\\s*['"]${NET_MODULES}['"]\\s*\\)`),
  new RegExp(`^\\s*import\\s+['"]${NET_MODULES}['"]`), // bare side-effect import
  /\bhttp\.(?:request|get)\s*\(/, // the usual alias, even without an import line to resolve
  /['"]undici['"]/,
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\b/,
  /\bXMLHttpRequest\b/,
];
const WEB_FORBIDDEN = [/https?:\/\//, /\bv-html\b/, /\binnerHTML\b/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/];
const FETCH = /\bfetch\s*\(/;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(?:ts|mts|cts|js|mjs|cjs|vue|html)$/.test(entry.name)) yield p;
  }
}

// node:http itself is allowed for serving, but not for making requests: no http.request/http.get through
// whatever name it is imported under, and no named import of request/get.
const HTTP_IMPORT = /\bimport\s+(?:\*\s+as\s+(\w+)|(\w+))\s*(?:,\s*\{[^}]*\}\s*)?from\s+['"](?:node:)?http['"]/g;
const HTTP_NAMED = /\bimport\s*(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s+['"](?:node:)?http['"]/g;
function httpClientUse(text) {
  const bad = [];
  for (const m of text.matchAll(HTTP_IMPORT)) {
    const name = m[1] ?? m[2];
    if (new RegExp(`\\b${name}\\s*\\.\\s*(?:request|get)\\s*\\(`).test(text)) bad.push(`${name}.request/get`);
  }
  for (const m of text.matchAll(HTTP_NAMED)) {
    for (const part of m[1].split(',')) {
      const orig = part.trim().split(/\s+as\s+/)[0];
      if (orig === 'request' || orig === 'get') bad.push(`named import ${orig}`);
    }
  }
  return bad;
}

const hits = [];
function scan(dir, rules, allowFetchIn) {
  for (const file of walk(dir)) {
    const fetchOk = allowFetchIn !== undefined && path.basename(file) === allowFetchIn;
    const text = fs.readFileSync(file, 'utf8');
    if (allowFetchIn === undefined) for (const why of httpClientUse(text)) hits.push(`${path.relative(ui, file)}: outbound node:http use (${why})`);
    text
      .split('\n')
      .forEach((line, i) => {
        const bad = rules.some((re) => re.test(line)) || (allowFetchIn !== undefined && !fetchOk && FETCH.test(line));
        if (bad) hits.push(`${path.relative(ui, file)}:${i + 1}: ${line.trim()}`);
      });
  }
}

scan(path.join(ui, 'server'), SERVER_FORBIDDEN);
scan(path.join(ui, 'web', 'src'), WEB_FORBIDDEN, 'api.ts');

if (hits.length > 0) {
  process.stderr.write(`Forbidden network or HTML use in the UI package (${ui}):\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check:ui-network: ok (${path.relative(ROOT, ui) || '.'})\n`);
