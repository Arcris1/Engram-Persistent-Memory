import { claimSources, readClaim, rowToClaim, type ClaimRow, type RawClaimRow } from './claims.js';
import { readEvent, type EventRow } from '../events/events.js';
import type { Db } from '../storage/db.js';

export interface AccessRow {
  id: string;
  ts: string;
  target_id: string;
  query: string | null;
  used: number;
}

export type Explanation =
  | {
      kind: 'claim';
      item: ClaimRow;
      sources: { event: EventRow; excerpt: string | null }[];
      superseded_by: ClaimRow | null;
      supersedes: ClaimRow[];
      access_history: AccessRow[];
    }
  | {
      kind: 'event';
      item: EventRow;
      /** Each derived claim's own full source list (not just this event) -- for faithful re-framing. */
      derived_claims: { claim: ClaimRow; source_ids: string[] }[];
      access_history: AccessRow[];
    };

function accessHistory(db: Db, targetId: string): AccessRow[] {
  return db.prepare(`SELECT * FROM accesses WHERE target_id = ? ORDER BY ts ASC`).all(targetId) as AccessRow[];
}

export function explain(db: Db, id: string): Explanation | undefined {
  const claim = readClaim(db, id);
  if (claim) {
    const srcRows = db
      .prepare(`SELECT event_id, excerpt FROM claim_sources WHERE claim_id = ?`)
      .all(id) as { event_id: string; excerpt: string | null }[];
    const sources = srcRows
      .map((r) => ({ event: readEvent(db, r.event_id)!, excerpt: r.excerpt }))
      .sort((a, b) => (a.event.ts < b.event.ts ? -1 : a.event.ts > b.event.ts ? 1 : 0));

    const supersededBy = claim.superseded_by ? (readClaim(db, claim.superseded_by) ?? null) : null;
    const supersedes = (
      db.prepare(`SELECT * FROM claims WHERE superseded_by = ?`).all(id) as RawClaimRow[]
    ).map(rowToClaim);

    return {
      kind: 'claim',
      item: claim,
      sources,
      superseded_by: supersededBy,
      supersedes,
      access_history: accessHistory(db, id),
    };
  }

  const event = readEvent(db, id);
  if (event) {
    const derivedClaims = (
      db
        .prepare(
          `SELECT c.* FROM claims c JOIN claim_sources cs ON cs.claim_id = c.id WHERE cs.event_id = ?`,
        )
        .all(id) as RawClaimRow[]
    )
      .map(rowToClaim)
      .map((claim) => ({ claim, source_ids: claimSources(db, claim.id).map((s) => s.event_id) }));

    return {
      kind: 'event',
      item: event,
      derived_claims: derivedClaims,
      access_history: accessHistory(db, id),
    };
  }

  return undefined;
}
