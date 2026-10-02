import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
