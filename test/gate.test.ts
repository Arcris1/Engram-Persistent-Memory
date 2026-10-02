import { describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events/events.js';
import { gateNeed, gateTerms } from '../src/search/gate.js';
import { searchEventsRanked } from '../src/search/events.js';
import { openDb, type Db } from '../src/storage/db.js';
import { tmpDbFile } from './helpers.js';

/**
 * D40 pre-registered precision gates (Phase 5 Task 3c). The gate parameters themselves (stopword
 * list, k, need formulas for A/B) are FROZEN -- these tests pin the frozen behavior, they do not
 * tune it.
 */

describe('gateTerms: stopword removal', () => {
  it('drops NLTK stopwords, keeps content words, lowercases, and de-duplicates', () => {
    expect(gateTerms('What database did I choose for the billing service?')).toEqual({
      terms: ['database', 'choose', 'billing', 'service'],
      k: 4,
    });
  });

  it('is case-insensitive and de-duplicates across case', () => {
    expect(gateTerms('Postgres postgres POSTGRES')).toEqual({ terms: ['postgres'], k: 1 });
  });

  it('drops punctuation/FTS-operator characters the same way toFtsQuery tokenizes', () => {
    // 'and' is itself a stopword, so only 'postgres'/'billing' are content terms (k=2); 'and' is
    // dropped from `terms` too since content terms exist (no fallback triggered).
    expect(gateTerms('postgres* AND (billing')).toEqual({ terms: ['postgres', 'billing'], k: 2 });
  });
});

describe('gateTerms: fallback when no content tokens remain', () => {
  it('falls back to the full distinct token set, with k=0', () => {
    // "is", "it", "the" are all NLTK stopwords -> zero content terms remain.
    expect(gateTerms('Is it the')).toEqual({ terms: ['is', 'it', 'the'], k: 0 });
  });

  it('an empty/punctuation-only query yields k=0 and an empty term set (nothing to fall back to)', () => {
    expect(gateTerms('!!! ???')).toEqual({ terms: [], k: 0 });
  });
});

describe('gateNeed: frozen need formulas, k = 1..8', () => {
  // Gate A (preferred): need = max(ceil(k/2), k>=3 ? 2 : 1).
  const expectedA: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4 };
  // Gate B: need = floor(k/3) + 1.
  const expectedB: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3 };

  for (let k = 1; k <= 8; k++) {
    it(`gate A: k=${k} -> need=${expectedA[k]}`, () => {
      expect(gateNeed('A', k)).toBe(expectedA[k]);
    });
    it(`gate B: k=${k} -> need=${expectedB[k]}`, () => {
      expect(gateNeed('B', k)).toBe(expectedB[k]);
    });
  }

  it('gate A at k=0 degrades to need=1 (trivial -- matches the D40 k=0 fallback behavior)', () => {
    expect(gateNeed('A', 0)).toBe(1);
  });

  it('gate B at k=0 degrades to need=1', () => {
    expect(gateNeed('B', 0)).toBe(1);
  });
});

describe('gating happens BEFORE the max(limit*5, 50) pool limit', () => {
  let db: Db;

  /**
   * Seeds a corpus where, for the 3-term query "wobbleterm squiggleterm rareterm" (k=3, need=2 for
   * both gate A and gate B):
   * - id target: matches 2 of 3 terms ("wobbleterm", "squiggleterm") -- PASSES the gate.
   * - 56 distractors: match only 1 term ("rareterm", repeated for a strong single-term bm25 score)
   *   -- FAIL the gate (need=2).
   * - 100 "flood" events: also contain "wobbleterm"+"squiggleterm" (so they dilute those two terms'
   *   corpus frequency enough that raw bm25 ranks the target BELOW all 56 distractors -- verified
   *   empirically against real better-sqlite3 FTS5 bm25, not assumed).
   * Net effect: in the raw, ungated OR-match order the target lands at position 56 (0-indexed) --
   * beyond the default pool limit of 50 -- so `gate: 'none'` (or any gate applied only AFTER the pool
   * limit) can never return it. Pre-pool-limit gating removes all 56 distractors first, leaving the
   * target as the best-bm25 survivor, well inside the limit.
   */
  function seed(): { targetId: string } {
    db = openDb(tmpDbFile());
    const targetId = appendEvent(db, {
      sessionId: 's', role: 'user', content: 'wobbleterm squiggleterm', sourceRef: 'target',
    }).id;
    for (let i = 0; i < 56; i++) {
      appendEvent(db, {
        sessionId: 's',
        role: 'user',
        content: 'rareterm rareterm rareterm rareterm rareterm rareterm',
        sourceRef: `distractor-${i}`,
      });
    }
    for (let i = 0; i < 100; i++) {
      appendEvent(db, {
        sessionId: 's',
        role: 'user',
        content: 'wobbleterm squiggleterm filler padding text here now',
        sourceRef: `flood-${i}`,
      });
    }
    return { targetId };
  }

  const QUERY = 'wobbleterm squiggleterm rareterm';
  const now = '2026-10-01T00:00:00.000Z';

  it('confirms the premise: the target is beyond the raw bm25 pool limit (not in gate:none results)', () => {
    const { targetId } = seed();
    const hits = searchEventsRanked(db, { query: QUERY, mode: 'keyword', limit: 50 }, now);
    expect(hits.map((h) => h.id)).not.toContain(targetId);
  });

  it('gate A recovers the target by filtering before the pool limit is applied', () => {
    const { targetId } = seed();
    const hits = searchEventsRanked(db, { query: QUERY, mode: 'keyword', limit: 5, gate: 'A' }, now);
    expect(hits.map((h) => h.id)).toContain(targetId);
  });

  it('gate B recovers the target by filtering before the pool limit is applied', () => {
    const { targetId } = seed();
    const hits = searchEventsRanked(db, { query: QUERY, mode: 'keyword', limit: 5, gate: 'B' }, now);
    expect(hits.map((h) => h.id)).toContain(targetId);
  });

  it('gate:none (explicit) matches the default -- target still excluded', () => {
    const { targetId } = seed();
    const hits = searchEventsRanked(db, { query: QUERY, mode: 'keyword', limit: 50, gate: 'none' }, now);
    expect(hits.map((h) => h.id)).not.toContain(targetId);
  });
});
