import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db.js';
import { getStats, StatsSchema } from '../src/storage/stats.js';
import { runCli, tmpDbFile } from './helpers.js';

describe('getStats', () => {
  it('reports an empty database', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    const s = getStats(db, file);
    expect(s.events).toBe(0);
    expect(s.sessions).toBe(0);
    expect(s.claims).toEqual({ active: 0, superseded: 0, retracted: 0 });
    expect(s.oldest_event).toBeNull();
    expect(s.db_bytes).toBeGreaterThan(0);
    db.close();
  });
});

describe('engram stats', () => {
  it('prints an empty-DB report (Phase 0 acceptance)', () => {
    const r = runCli(['stats'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(0);
    // D42/Phase 6 Task 2 bumped SCHEMA_VERSION to 3 (embeddings table).
    expect(r.stdout).toContain('schema v3');
    expect(r.stdout).toContain('events:    0');
    expect(r.stdout).toContain('sessions:  0 (0 unconsolidated)');
  });

  it('--json output matches StatsSchema', () => {
    const r = runCli(['stats', '--json'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(0);
    expect(() => StatsSchema.parse(JSON.parse(r.stdout))).not.toThrow();
  });

  it('rejects unknown commands with usage on stderr', () => {
    const r = runCli(['nope'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command 'nope'");
    expect(r.stderr).toContain('usage: engram');
  });
});
