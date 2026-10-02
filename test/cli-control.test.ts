import { describe, expect, it } from 'vitest';
import { upsertClaims, type ClaimInput } from '../src/claims/claims.js';
import { appendEvent } from '../src/events/events.js';
import { openDb, type Db } from '../src/storage/db.js';
import { runCli, tmpDbFile } from './helpers.js';

function claimInput(eventId: string, excerpt: string, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    subject: 'project:billing',
    predicate: 'uses_database',
    object: 'PostgreSQL',
    statement: 'The billing project uses PostgreSQL.',
    scope: 'fact',
    confidence: 0.9,
    project: 'engram',
    sources: [{ event_id: eventId, excerpt }],
    ...overrides,
  };
}

function seedClaim(db: Db): { eventId: string; claimId: string } {
  const eventId = appendEvent(db, {
    sessionId: 's', role: 'user', content: 'We decided to use PostgreSQL for billing.', project: 'engram',
  }).id;
  const claimId = upsertClaims(db, { claims: [claimInput(eventId, 'use PostgreSQL for billing')] }).inserted[0]!;
  return { eventId, claimId };
}

describe('engram list', () => {
  it('defaults to active claims, 20 limit, one plain line per claim', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { claimId } = seedClaim(db);
    db.close();

    const r = runCli(['list'], { dbFile });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(claimId);
    expect(lines[0]).toContain('[engram]');
    expect(lines[0]).toContain('The billing project uses PostgreSQL.');
  });

  it('--events lists events instead of claims', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { eventId } = seedClaim(db);
    db.close();

    const r = runCli(['list', '--events'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(eventId);
    expect(r.stdout).toContain('We decided to use PostgreSQL for billing.');
  });

  it('--limit caps the number of rows', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    for (let i = 0; i < 3; i++) {
      const ev = appendEvent(db, { sessionId: 's', role: 'user', content: `Claim number ${i} about topic ${i}` }).id;
      const result = upsertClaims(db, {
        claims: [
          claimInput(ev, `about topic ${i}`, {
            object: `topic-${i}`,
            statement: `Claim number ${i} about topic ${i}`,
          }),
        ],
      });
      if (result.rejected.length > 0) throw new Error(`seed rejected: ${result.rejected[0]!.reason}`);
    }
    db.close();

    const r = runCli(['list', '--limit', '2'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(2);
  });

  it('--project filters to that project', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const evA = appendEvent(db, { sessionId: 's', role: 'user', content: 'Project A uses tool alpha.' }).id;
    upsertClaims(db, {
      claims: [claimInput(evA, 'uses tool alpha', { project: 'alpha-repo', object: 'alpha-tool', statement: 'Project A uses tool alpha.' })],
    });
    const evB = appendEvent(db, { sessionId: 's', role: 'user', content: 'Project B uses tool beta.' }).id;
    upsertClaims(db, {
      claims: [claimInput(evB, 'uses tool beta', { project: 'beta-repo', object: 'beta-tool', statement: 'Project B uses tool beta.' })],
    });
    db.close();

    const r = runCli(['list', '--project', 'alpha-repo'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Project A uses tool alpha.');
    expect(r.stdout).not.toContain('Project B uses tool beta.');
  });
});

describe('engram explain', () => {
  it('explains a claim: statement, sources and the chain', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { eventId, claimId } = seedClaim(db);
    db.close();

    const r = runCli(['explain', claimId], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(claimId);
    expect(r.stdout).toContain('The billing project uses PostgreSQL.');
    expect(r.stdout).toContain(eventId);
  });

  it('explains an event: content and derived claims', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { eventId, claimId } = seedClaim(db);
    db.close();

    const r = runCli(['explain', eventId], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(eventId);
    expect(r.stdout).toContain(claimId);
  });

  it('unknown id: engram: <message> on stderr, exit 1, no stack trace', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['explain', 'nope'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe('engram: no claim or event with id nope');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('engram forget', () => {
  it('previews without --yes and deletes nothing', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { claimId } = seedClaim(db);
    db.close();

    const r = runCli(['forget', claimId], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('--yes');

    const db2 = openDb(dbFile);
    const row = db2.prepare('SELECT 1 FROM claims WHERE id = ?').get(claimId);
    db2.close();
    expect(row).toBeDefined();
  });

  it('H5: preview warns when another event has the same content (forget is per item)', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const canary = 'Duplicate wording that shows up in two events.';
    const evA = appendEvent(db, { sessionId: 's', role: 'user', content: canary, sourceRef: 'line-1' }).id;
    const evB = appendEvent(db, { sessionId: 's', role: 'user', content: canary, sourceRef: 'line-2' }).id;
    db.close();

    const r = runCli(['forget', evA], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Forget removes this item only; the same text may remain in:');
    expect(r.stdout).toContain(evB);
  });

  it('--yes deletes and reports counts', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { claimId } = seedClaim(db);
    db.close();

    const r = runCli(['forget', claimId, '--yes'], { dbFile });
    expect(r.status).toBe(0);

    const db2 = openDb(dbFile);
    const row = db2.prepare('SELECT 1 FROM claims WHERE id = ?').get(claimId);
    db2.close();
    expect(row).toBeUndefined();
  });

  it('unknown id: engram: <message> on stderr, exit 1, no stack trace', () => {
    const dbFile = tmpDbFile();
    const r = runCli(['forget', 'nope', '--yes'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe('engram: no claim or event with id nope');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('--yes while paused refuses with the exact paused text and deletes nothing', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const { claimId } = seedClaim(db);
    db.close();

    runCli(['pause'], { dbFile });
    const r = runCli(['forget', claimId, '--yes'], { dbFile });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe('engram is paused; nothing was written.');

    runCli(['resume'], { dbFile });
    const db2 = openDb(dbFile);
    const row = db2.prepare('SELECT 1 FROM claims WHERE id = ?').get(claimId);
    db2.close();
    expect(row).toBeDefined();
  });
});

describe('H8: list/explain strip ASCII control characters from printed content', () => {
  it('engram list strips a stray control character (e.g. an ESC) and collapses a literal newline to a space', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const esc = '\x1b';
    appendEvent(db, { sessionId: 's', role: 'user', content: `line one${esc}[2Jline two\nline three` });
    db.close();

    const r = runCli(['list', '--events'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(esc);
    expect(r.stdout).toContain('line one[2Jline two line three');
  });

  it('engram explain strips a stray control character but keeps a literal newline as a real line break', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const esc = '\x1b';
    const eventId = appendEvent(db, { sessionId: 's', role: 'user', content: `line one${esc}[2Jline two\nline three` }).id;
    db.close();

    const r = runCli(['explain', eventId], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(esc);
    expect(r.stdout).toContain('line one[2Jline two\nline three');
  });
});

describe('friendly CLI errors', () => {
  it('unknown command stays on the existing usage path (engram: unknown command)', () => {
    const r = runCli(['nope'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("engram: unknown command 'nope'");
  });

  it('a thrown command error never leaks a stack trace unless ENGRAM_DEBUG=1', () => {
    const dbFile = tmpDbFile();
    const withoutDebug = runCli(['explain', 'nope'], { dbFile });
    expect(withoutDebug.stderr).not.toMatch(/\n\s+at /);

    const withDebug = runCli(['explain', 'nope'], { dbFile, env: { ENGRAM_DEBUG: '1' } });
    expect(withDebug.status).toBe(1);
    expect(withDebug.stderr).toContain('engram: no claim or event with id nope');
    expect(withDebug.stderr).toMatch(/\n\s+at /);
  });
});
