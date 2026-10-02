import fs from 'node:fs';
import path from 'node:path';

/** D13: basename of the nearest ancestor containing `.git` (dir or worktree file), else basename(cwd). */
export function projectFromCwd(cwd?: string): string | null {
  if (!cwd) return null;
  const start = path.resolve(cwd);
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.basename(start) || null;
}
