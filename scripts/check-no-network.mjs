#!/usr/bin/env node
// HANDOFF §9.4 / DECISIONS D14: no network access in engram's own source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src');
const NET_MODULES = '(?:node:)?(?:http|https|http2|net|tls|dgram)';
const FORBIDDEN = [
  new RegExp(`from\\s+['"]${NET_MODULES}['"]`),
  new RegExp(`import\\(\\s*['"]${NET_MODULES}['"]\\s*\\)`),
  new RegExp(`require\\(\\s*['"]${NET_MODULES}['"]\\s*\\)`),
  /['"]undici['"]/,
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\b/,
  /\bXMLHttpRequest\b/,
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) yield p;
  }
}

const hits = [];
for (const file of walk(target)) {
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${path.relative(target, file)}:${i + 1}: ${line.trim()}`);
    });
}

if (hits.length > 0) {
  process.stderr.write(`Network access is forbidden in ${target} (HANDOFF §9.4):\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check:network: no network use in ${path.relative(ROOT, target) || '.'}\n`);
