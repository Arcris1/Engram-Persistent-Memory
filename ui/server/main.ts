import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, openDb } from './core.js';
import { startServer } from './http.js';

const USAGE = 'usage: engram ui [--port N] [--no-open]';

function parseArgs(args: string[]): { port: number | undefined; open: boolean } | undefined {
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--no-open') open = false;
    else if (a === '--port') {
      const v = args[++i] ?? '';
      if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) return undefined;
      port = Number(v);
    } else return undefined;
  }
  return { port, open };
}

/** Best effort: failing to open a browser is not an error (the URL is printed). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!cmd) return;
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignored */
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  let dbFile: string;
  let db: ReturnType<typeof openDb>;
  try {
    dbFile = dbPath();
    db = openDb(dbFile);
  } catch (err) {
    // A bad ENGRAM_DB (relative path, unreadable file ...): one line, no stack trace.
    process.stderr.write(`engram ui: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  // Compiled to ui/dist/main.js: the built web app sits next to it in ui/dist/web.
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  let server;
  try {
    server = await startServer({ db, dbFile, port: args.port, webRoot });
  } catch (err) {
    db.close();
    process.stderr.write(`engram: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  process.stdout.write(`engram UI: ${server.url}\nPress Ctrl+C to stop\n`);
  if (args.open) openBrowser(server.url);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
