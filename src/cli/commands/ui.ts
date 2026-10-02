import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// <repo root>/dist/cli/commands/ui.js -> three levels up is the install root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * `engram ui [--port N] [--no-open]`: runs the separate UI server package (ui/dist/main.js) as a
 * child process in the foreground and returns its exit code. The listener lives in that package, not
 * here: src/ stays free of network code (HANDOFF §9.4, D14; see D45). Only `node:child_process` is used.
 */
export async function uiCommand(args: string[]): Promise<number> {
  const entry = process.env.ENGRAM_UI_ENTRY ?? path.join(ROOT, 'ui', 'dist', 'main.js');
  if (!fs.existsSync(entry)) {
    process.stderr.write(`engram: the UI is not built; run 'npm run build' in ${ROOT}\n`);
    return 1;
  }
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit' });
    // Ctrl+C reaches the child too (same foreground process group); a `kill -INT <parent>` does not, so
    // forward SIGINT as well (the child sees it twice on Ctrl+C, which its shutdown tolerates). This
    // process outlives the child's shutdown and returns its exit code; SIGTERM is forwarded likewise.
    const forwardInt = (): void => {
      child.kill('SIGINT');
    };
    const forwardTerm = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', forwardInt);
    process.on('SIGTERM', forwardTerm);
    const done = (code: number): void => {
      process.off('SIGINT', forwardInt);
      process.off('SIGTERM', forwardTerm);
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`engram: could not start the UI: ${err.message}\n`);
      done(1);
    });
    // A child that ended on SIGINT is a normal stop.
    child.on('close', (code, signal) => done(signal === 'SIGINT' ? 0 : (code ?? 1)));
  });
}
