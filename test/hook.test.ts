import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendHooksLog, HOOKS_LOG_MAX_BYTES, logHookError } from '../src/cli/hook.js';
import { tmpDbFile } from './helpers.js';

let prevDb: string | undefined;
function useDb(dbFile: string): void {
  prevDb = process.env.ENGRAM_DB;
  process.env.ENGRAM_DB = dbFile;
}
afterEach(() => {
  if (prevDb === undefined) delete process.env.ENGRAM_DB;
  else process.env.ENGRAM_DB = prevDb;
  prevDb = undefined;
});

describe('G5: appendHooksLog rotation', () => {
  it('rotates a >1MiB hooks.log to hooks.log.1 on the next append, replacing any previous .1', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const logFile = path.join(path.dirname(dbFile), 'hooks.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, 'x'.repeat(HOOKS_LOG_MAX_BYTES + 100_000));
    fs.writeFileSync(`${logFile}.1`, 'stale previous rotation');

    appendHooksLog('fresh line\n');

    expect(fs.readFileSync(`${logFile}.1`, 'utf8').startsWith('x'.repeat(10))).toBe(true);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('fresh line\n');
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it('does not rotate a log under the cap', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const logFile = path.join(path.dirname(dbFile), 'hooks.log');
    appendHooksLog('line one\n');
    appendHooksLog('line two\n');
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('line one\nline two\n');
  });
});

describe('G1/G6: logHookError lock-vs-stack formatting', () => {
  it('logs a lock error as a single "database locked; deferred" line, not a stack', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    logHookError('ingest-prompt', err);
    const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
    expect(log).toMatch(/\[ingest-prompt\] database locked; deferred\n$/);
    expect(log).not.toContain('SQLITE_BUSY');
    expect(log).not.toContain('at ');
  });

  it('logs a non-lock error with its redacted message', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    logHookError('session-start', new Error('boom'));
    const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
    expect(log).toContain('[session-start]');
    expect(log).toContain('boom');
  });
});
