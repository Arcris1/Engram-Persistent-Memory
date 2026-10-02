import { beforeEach, describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { appendEvent } from '../src/events/events.js';
import { searchClaims } from '../src/search/claims.js';
import { openDb, type Db } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

let db: Db;
const ev: Record<string, string> = {};
const claimId: Record<string, string> = {};

beforeEach(() => {
  db = openDb(tmpDbFile());

  ev.pnpm = appendEvent(db, {
    sessionId: 's1', role: 'user', kind: 'message',
    content: 'I prefer pnpm as my package manager for all repos.', ts: '2026-09-01T10:00:00Z',
  }).id;
  ev.pg = appendEvent(db, {
    sessionId: 's1', role: 'user', kind: 'message',
    content: 'We use PostgreSQL for the billing project.', ts: '2026-09-02T10:00:00Z',
  }).id;
  ev.redis = appendEvent(db, {
    sessionId: 's1', role: 'user', kind: 'message',
    content: 'Billing moved from PostgreSQL to Redis for caching.', ts: '2026-09-05T10:00:00Z',
  }).id;
  ev.special = appendEvent(db, {
    sessionId: 's1', role: 'user', kind: 'message',
    content: 'The %special report is generated nightly.', ts: '2026-09-06T10:00:00Z',
  }).id;

  // Global claim.
  claimId.pnpm = upsertClaims(db, {
    claims: [{
      subject: 'user', predicate: 'prefers_package_manager', object: 'pnpm',
      statement: 'User prefers pnpm as their package manager.',
      scope: 'fact', confidence: 0.9,
      sources: [{ event_id: ev.pnpm, excerpt: 'I prefer pnpm as my package manager' }],
    }],
  }).inserted[0]!;

  // Project claim (will be superseded below).
  claimId.pg = upsertClaims(db, {
    claims: [{
      subject: 'project:billing', predicate: 'uses_database', object: 'PostgreSQL',
      statement: 'The billing project uses PostgreSQL.',
      scope: 'fact', confidence: 0.9, project: 'billing',
      sources: [{ event_id: ev.pg, excerpt: 'We use PostgreSQL for the billing project' }],
    }],
  }).inserted[0]!;

  // Supersedes the PostgreSQL claim -> claimId.pg becomes status 'superseded'.
  claimId.redis = upsertClaims(db, {
    claims: [{
      subject: 'project:billing', predicate: 'uses_database', object: 'Redis',
      statement: 'The billing project moved to Redis for caching.',
      scope: 'fact', confidence: 0.9, project: 'billing',
      sources: [{ event_id: ev.redis, excerpt: 'to Redis for caching' }],
      supersedes: claimId.pg,
    }],
  }).inserted[0]!;

  // A claim with a subject literally starting with '%', to exercise LIKE escaping positively.
  claimId.special = upsertClaims(db, {
    claims: [{
      subject: '%special', predicate: 'generated', object: 'nightly',
      statement: 'The percent-special report is generated nightly.',
      scope: 'fact', confidence: 0.8,
      sources: [{ event_id: ev.special, excerpt: 'is generated nightly' }],
    }],
  }).inserted[0]!;
});

describe('searchClaims keyword', () => {
  it('finds a claim by a statement word', () => {
    const hits = searchClaims(db, { query: 'package manager', mode: 'keyword', limit: 10 });
    expect(hits.map((h) => h.id)).toContain(claimId.pnpm);
  });

  it('stems (porter): query "preferred" matches statement "prefers"', () => {
    const hits = searchClaims(db, { query: 'preferred', mode: 'keyword', limit: 10 });
    expect(hits.map((h) => h.id)).toContain(claimId.pnpm);
  });

  it('survives FTS syntax / punctuation in the query', () => {
    expect(() => searchClaims(db, { query: '"pnpm* AND (', mode: 'keyword', limit: 10 })).not.toThrow();
  });

  it('excludes superseded claims by default, includes them with include_superseded', () => {
    const active = searchClaims(db, { query: 'billing', mode: 'keyword', limit: 10 });
    expect(active.map((h) => h.id)).toContain(claimId.redis);
    expect(active.map((h) => h.id)).not.toContain(claimId.pg);

    const all = searchClaims(db, { query: 'billing', mode: 'keyword', limit: 10, include_superseded: true });
    expect(all.map((h) => h.id)).toEqual(expect.arrayContaining([claimId.pg, claimId.redis]));
  });

  it('project filter: a named project returns that project\'s claims and global claims; null returns only global', () => {
    const billing = searchClaims(db, { query: 'billing package', mode: 'keyword', limit: 10, project: 'billing' });
    expect(billing.map((h) => h.id)).toEqual(expect.arrayContaining([claimId.redis, claimId.pnpm]));
    expect(billing.length).toBe(2);

    const web = searchClaims(db, { query: 'billing package', mode: 'keyword', limit: 10, project: 'web' });
    expect(web.map((h) => h.id)).toEqual([claimId.pnpm]);

    const globalOnly = searchClaims(db, { query: 'billing package', mode: 'keyword', limit: 10, project: null });
    expect(globalOnly.map((h) => h.id)).toEqual([claimId.pnpm]);
  });

  it('carries sources on every hit', () => {
    const [hit] = searchClaims(db, { query: 'pnpm', mode: 'keyword', limit: 10 });
    expect(hit!.sources).toEqual([{ event_id: ev.pnpm, excerpt: 'I prefer pnpm as my package manager' }]);
  });
});

describe('searchClaims subject', () => {
  it('matches by subject prefix', () => {
    const hits = searchClaims(db, { query: 'project:', mode: 'subject', limit: 10, include_superseded: true });
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining([claimId.pg, claimId.redis]));
    expect(hits.map((h) => h.id)).not.toContain(claimId.pnpm);
  });

  it('orders by subject then predicate then recency', () => {
    const hits = searchClaims(db, { query: 'project:', mode: 'subject', limit: 10, include_superseded: true });
    expect(hits.map((h) => h.id)).toEqual([claimId.redis, claimId.pg]); // same subject/predicate, newer first
  });

  it('escapes "%" in the prefix: a literal "%" query only matches a subject literally starting with "%"', () => {
    const hits = searchClaims(db, { query: '%', mode: 'subject', limit: 10 });
    expect(hits.map((h) => h.id)).toEqual([claimId.special]);
  });

  it('escapes "_" in the prefix: a literal "_" query matches nothing here', () => {
    expect(searchClaims(db, { query: '_', mode: 'subject', limit: 10 })).toEqual([]);
  });

  it('returns all active claims for an empty query', () => {
    const hits = searchClaims(db, { query: '', mode: 'subject', limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(
      expect.arrayContaining([claimId.pnpm, claimId.redis, claimId.special]),
    );
    expect(hits.length).toBe(3); // claimId.pg is superseded, excluded by default
  });
});
