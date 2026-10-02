import type { Db } from '../storage/db.js';
import { NLTK_STOPWORDS } from './stopwords.js';

/**
 * D40 pre-registered retrieval-quality gates (Phase 5 Task 3c). FROZEN -- do not change the
 * parameters below (stopword list, k definition, need formulas). The production default stays
 * 'none'; a gate is adopted only per D40's held-out ruling.
 */
export type Gate = 'none' | 'A' | 'B';

/** Same word-token extraction as `toFtsQuery` (src/search/fts.ts), kept independent and untouched
 * there so the 'none' path (default) stays byte-identical. */
function wordTokens(text: string): string[] {
  return text.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export interface GateTerms {
  /** The terms used for gate matching: content terms (post stopword-removal) when any remain,
   * otherwise every distinct lowercased token (fallback). */
  terms: string[];
  /** k = the number of distinct content terms remaining after stopword removal -- per D40, this is
   * the content-term count itself (may be 0 when the query is entirely stopwords), not the length of
   * the post-fallback `terms` set. The need formulas below both degrade to need=1 at k=0, which is
   * correct: an all-stopword query gates almost not at all, matching on whatever fallback terms hit. */
  k: number;
}

/**
 * D40 "Query building": distinct, lowercased word tokens, minus the NLTK English stopword list
 * (src/search/stopwords.ts). If no content tokens remain, matching falls back to the full distinct
 * token set (so an all-stopword query like "is it" still has something to gate against).
 */
export function gateTerms(query: string): GateTerms {
  const distinct = Array.from(new Set(wordTokens(query).map((t) => t.toLowerCase())));
  const content = distinct.filter((t) => !NLTK_STOPWORDS.has(t));
  return { terms: content.length > 0 ? content : distinct, k: content.length };
}

/**
 * D40 frozen need thresholds. Gate A (preferred): need = max(ceil(k/2), k>=3 ? 2 : 1).
 * Gate B: need = floor(k/3) + 1. Do not change these formulas.
 */
export function gateNeed(gate: 'A' | 'B', k: number): number {
  if (gate === 'A') return Math.max(Math.ceil(k / 2), k >= 3 ? 2 : 1);
  return Math.floor(k / 3) + 1;
}

/**
 * D40: "a row matches a term when the single-term FTS5 MATCH (porter, quoted) hits that row."
 * Returns the subset of `candidateRowids` (claims.seq / events.seq -- the FTS tables' content_rowid,
 * D5) that match at least `need` of `terms`. Intended to run over the FULL OR-match candidate set
 * (before the `max(limit*5, 50)` pool limit is applied), per D40's "candidate filter BEFORE the pool
 * limit" rule -- callers must not pre-truncate `candidateRowids`.
 */
export function rowsMeetingGate(
  db: Db,
  ftsTable: 'events_fts' | 'claims_fts',
  candidateRowids: readonly number[],
  terms: readonly string[],
  need: number,
): Set<number> {
  const passed = new Set<number>();
  if (candidateRowids.length === 0 || terms.length === 0) return passed;

  const candidateSet = new Set(candidateRowids);
  const counts = new Map<number, number>();
  const stmt = db.prepare(`SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?`);
  for (const term of terms) {
    const rows = stmt.all(`"${term}"`) as { rowid: number }[];
    for (const { rowid } of rows) {
      if (!candidateSet.has(rowid)) continue; // only count rows already in the OR-match candidate set
      counts.set(rowid, (counts.get(rowid) ?? 0) + 1);
    }
  }
  for (const id of candidateRowids) {
    if ((counts.get(id) ?? 0) >= need) passed.add(id);
  }
  return passed;
}
