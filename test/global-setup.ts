import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test helper (and every CLI/hook process a test spawns) creates its scratch files under
 * os.tmpdir() and never removes them. Over hundreds of runs that left ~83,000 `engram-test-*`
 * directories (23 GB) behind and filled the disk (2026-10-02). Rather than trust each test to clean
 * up, the whole run gets ONE temp root: TMPDIR points at it before any worker is forked (forks and
 * spawned children inherit it), and it is deleted when the run ends -- pass, fail or Ctrl+C.
 */
export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engram-run-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const remove = (): void => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
  process.once('exit', remove);
  return () => {
    remove();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  };
}
