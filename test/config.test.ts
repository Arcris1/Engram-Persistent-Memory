import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbPath, loadConfig } from '../src/config.js';
import { tmpDbFile } from './helpers.js';

describe('dbPath', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ENGRAM_DB;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ENGRAM_DB;
    else process.env.ENGRAM_DB = saved;
  });

  it('expands a leading ~/ under os.homedir()', () => {
    process.env.ENGRAM_DB = '~/x/e.db';
    expect(dbPath()).toBe(path.join(os.homedir(), 'x/e.db'));
  });

  it('throws for a relative path', () => {
    process.env.ENGRAM_DB = 'relative/e.db';
    expect(() => dbPath()).toThrow(/absolute/);
  });

  it('passes an absolute path through unchanged', () => {
    process.env.ENGRAM_DB = '/tmp/engram-test/e.db';
    expect(dbPath()).toBe('/tmp/engram-test/e.db');
  });

  it('defaults to ~/.engram/engram.db when unset', () => {
    delete process.env.ENGRAM_DB;
    expect(dbPath()).toBe(path.join(os.homedir(), '.engram', 'engram.db'));
  });

  it('defaults to ~/.engram/engram.db when empty', () => {
    process.env.ENGRAM_DB = '';
    expect(dbPath()).toBe(path.join(os.homedir(), '.engram', 'engram.db'));
  });
});

describe('loadConfig: embedding (D42)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ENGRAM_DB;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ENGRAM_DB;
    else process.env.ENGRAM_DB = saved;
  });

  function withConfigJson(contents: string | undefined): void {
    const dbFile = tmpDbFile();
    process.env.ENGRAM_DB = dbFile;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    if (contents !== undefined) fs.writeFileSync(path.join(path.dirname(dbFile), 'config.json'), contents);
  }

  it('defaults to disabled with empty modelDir/sha256 when config.json is missing', () => {
    withConfigJson(undefined);
    expect(loadConfig().embedding).toEqual({ enabled: false, modelDir: '', sha256: '' });
  });

  it('parses an explicit embedding block', () => {
    withConfigJson(JSON.stringify({ embedding: { enabled: true, modelDir: '/models/minilm', sha256: 'a'.repeat(64) } }));
    expect(loadConfig().embedding).toEqual({ enabled: true, modelDir: '/models/minilm', sha256: 'a'.repeat(64) });
  });

  it('falls back to defaults when the embedding block is malformed', () => {
    withConfigJson(JSON.stringify({ embedding: { enabled: 'yes' } }));
    expect(loadConfig().embedding).toEqual({ enabled: false, modelDir: '', sha256: '' });
  });

  it('ingestToolResults and embedding are independent', () => {
    withConfigJson(JSON.stringify({ ingestToolResults: true, embedding: { enabled: true, modelDir: 'x', sha256: 'y' } }));
    const config = loadConfig();
    expect(config.ingestToolResults).toBe(true);
    expect(config.embedding).toEqual({ enabled: true, modelDir: 'x', sha256: 'y' });
  });
});
