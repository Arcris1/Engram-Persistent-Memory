#!/usr/bin/env node
// Demo launcher: seeds a throw-away database from eval/fixtures.json and serves the UI on it.
// Usage: node ui/scripts/demo.mjs [--no-open] [--port N]   (run `npm run build` first, or use `npm run ui:demo`)
// It never touches ~/.engram or ~/.claude: ENGRAM_DB points into a fresh temp dir BEFORE any engram module is
// imported, and the Health page checks a temp Claude dir (hooks installed there) with the `claude` shell-out disabled.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', '..', 'dist');
const uiDist = path.join(here, '..', 'dist');

const args = process.argv.slice(2);
const open = !args.includes('--no-open');
const portAt = args.indexOf('--port');
const port = portAt >= 0 ? Number(args[portAt + 1]) : undefined;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ui-demo-'));
const dbFile = path.join(dir, 'engram.db');
process.env.ENGRAM_DB = dbFile; // before importing anything that resolves the database path

// pathToFileURL escapes '#', '%', spaces and the like in repo paths.
const pathToUrl = (p) => pathToFileURL(p).href;

let db;
let server;
try {
  if (!fs.existsSync(path.join(uiDist, 'web', 'index.html')) || !fs.existsSync(path.join(dist, 'api.js'))) {
    process.stderr.write('The UI is not built. Run `npm run build` first (or `npm run ui:demo`).\n');
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  const { openDb } = await import(pathToUrl(path.join(dist, 'storage', 'db.js')));
  const { seed, loadFixtures } = await import(pathToUrl(path.join(dist, 'eval', 'run.js')));
  const { pin } = await import(pathToUrl(path.join(dist, 'control', 'marks.js')));
  const { appendEvent } = await import(pathToUrl(path.join(dist, 'events', 'events.js')));
  const { startServer } = await import(pathToUrl(path.join(uiDist, 'http.js')));

  db = openDb(dbFile);
  const { claimId } = seed(db, loadFixtures());
  for (const key of ['c_user_pm', 'c_user_tz2']) pin(db, claimId[key]);

  // The fixtures are dated in the past; add a little recent activity so the chart and the
  // "waiting to be turned into memories" notice have something to show.
  const counts = [3, 0, 41, 67, 12, 0, 0, 88, 156, 204, 97, 31, 142, 119];
  const today = new Date();
  counts.forEach((n, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (counts.length - 1 - i), 10, 0, 0);
    for (let k = 0; k < Math.min(n, 40); k++) {
      appendEvent(db, {
        sessionId: `demo-day-${i}`,
        role: k % 2 === 0 ? 'user' : 'assistant',
        kind: 'message',
        content: `Demo message ${i}-${k}`,
        project: null,
        ts: new Date(day.getTime() + k * 60_000).toISOString(),
        sourceRef: `demo-${i}-${k}`,
      });
    }
  });

  // The Health page reads this temp Claude dir, where engram's hooks are installed so the page looks like a healthy
  // install. `noMcp` means `claude` is never run: nothing outside `dir` is touched.
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const { doInstall } = await import(pathToUrl(path.join(dist, 'cli', 'commands', 'install.js')));
  doInstall({ claudeDir, noMcp: true });
  server = await startServer({ db, dbFile, port, webRoot: path.join(uiDist, 'web'), doctorOpts: { claudeDir, noMcp: true } });
  process.stdout.write(`engram UI demo: ${server.url}\nDemo data lives in ${dir} and is deleted when you press Ctrl+C.\n`);
  if (open && (process.platform === 'darwin' || process.platform === 'linux')) {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [server.url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
} catch (e) {
  // Anything that fails after the temp dir exists must not leave it behind.
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.stderr.write(`engram UI demo failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
