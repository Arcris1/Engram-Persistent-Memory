import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectFromCwd } from '../src/core/project.js';
import { tmpDir } from './helpers.js';

describe('projectFromCwd', () => {
  it('uses the git root basename from a nested directory', () => {
    const root = path.join(tmpDir(), 'billing-api');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    expect(projectFromCwd(path.join(root, 'src', 'deep'))).toBe('billing-api');
  });

  it('treats a .git file (worktree) as a root', () => {
    const root = path.join(tmpDir(), 'wt');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere');
    expect(projectFromCwd(root)).toBe('wt');
  });

  it('falls back to the cwd basename, and null without cwd', () => {
    const dir = path.join(tmpDir(), 'scratch');
    fs.mkdirSync(dir);
    expect(projectFromCwd(dir)).toBe('scratch');
    expect(projectFromCwd(undefined)).toBeNull();
  });
});
