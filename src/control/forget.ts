import { readClaim, type ClaimRow } from '../claims/claims.js';
import { eraseMatchingSpoolFiles } from '../cli/spool.js';
import { nowIso } from '../core/ids.js';
import { readEvent, type EventRow } from '../events/events.js';
import type { Db } from '../storage/db.js';

export interface ForgetPlan {
  target: { kind: 'event' | 'claim'; id: string };
  /** Event ids that were (or would be) deleted. */
  events: string[];
  /** Claim ids that were (or would be) deleted. */
  claims: string[];
  /** `hash:<content_hash>` resurrection-guard marks that were (or would be) added. */
  marks_added: string[];
  /** H5: claim ids that cite the forgotten event but keep at least one other source, so they survive
   * (as opposed to `claims`, whose *only* source was this event). Always [] for a claim-kind forget. */
  surviving_claims: string[];
  /** H5: other event ids (not the one being forgotten) sharing the same content_hash -- forget is per
   * item, not per text, so identical content under a different event id is left untouched. Always []
   * for a claim-kind forget. */
  same_content_events: string[];
  /** Task 0: for a claim-kind forget, the claim's own source event ids -- forgetting a claim never
   * deletes the events that contain the original text (only forgetting the event itself does); the
   * preview says so by name. Always [] for an event-kind forget (the event itself is what's deleted). */
  source_events: string[];
}

export interface ForgetResult {
  deleted: { events: number; claims: number; marks_deleted: number };
  plan: ForgetPlan;
  rebuilt: boolean;
  /** H8: true unless the confirmed WAL checkpoint couldn't fully run (e.g. an open reader elsewhere
   * holding a snapshot) -- `false` there means the data is still securely deleted (secure_delete
   * already zeroed the freed pages at commit time) but its pre-image may still be sitting in the
   * `-wal` file rather than having been flushed into the main db file and truncated. Always `true` for
   * a preview (`confirm=false`): nothing is checkpointed. */
  checkpointed: boolean;
  /** Task 0: true unless an FTS `optimize` step failed after the delete transaction committed -- the
   * deletion itself is still final either way (secure_delete already zeroed the freed pages at commit),
   * but `false` means the FTS segment b-tree may still hold a leftover indexed term until a later
   * optimize succeeds (D31's own reasoning for why `optimize` exists at all). Always `true` for a
   * preview: nothing is optimized. */
  optimized: boolean;
}

interface Outcome {
  kind: 'event' | 'claim';
  events: string[];
  claims: string[];
  marksAdded: string[];
  /** H2: count of pre-existing marks (e.g. a `pinned` note) deleted for the ids this forget removed. */
  marksDeleted: number;
  /** H5: see ForgetPlan.surviving_claims. */
  survivingClaims: string[];
  /** H5: see ForgetPlan.same_content_events. */
  sameContentEvents: string[];
  /** Task 0: see ForgetPlan.source_events. */
  sourceEvents: string[];
  /** Only set for an event-kind forget; used on confirm to erase matching spool files. */
  spoolTarget: { content: string; sourceRef: string } | null;
}

/**
 * H2: deletes every mark (any kind -- `pinned`, a stray `never_inject`, etc.) whose target_id is one
 * of the ids this forget is removing, so a pin/note on a forgotten claim or on a claim that's
 * orphaned by an event-forget cascade doesn't survive as a dangling row. The `hash:<content_hash>`
 * never_inject marks forget() itself adds (forgetClaim) use a different target_id ('hash:...', never
 * a bare claim/event id) and so are never matched here, regardless of call order.
 */
function deleteMarksForTargets(db: Db, targetIds: string[]): number {
  if (targetIds.length === 0) return 0;
  const res = db
    .prepare(`DELETE FROM marks WHERE target_id IN (${targetIds.map(() => '?').join(',')})`)
    .run(...targetIds);
  return res.changes;
}

/**
 * D42/Phase 6 Task 2: embeddings are derived, re-derivable data -- never their own source of truth --
 * so forgetting an event or claim deletes its embedding row too, in the same transaction as everything
 * else forget() deletes (never a separate, possibly-skippable step). `kind` matches the embeddings
 * table's own `target_kind` ('event' | 'claim'); `ids` is whatever set of that kind forget() is
 * removing (e.g. the forgotten event itself, or the claims orphaned by its cascade).
 */
function deleteEmbeddingsForTargets(db: Db, kind: 'event' | 'claim', ids: string[]): void {
  if (ids.length === 0) return;
  db.prepare(`DELETE FROM embeddings WHERE target_kind = ? AND target_id IN (${ids.map(() => '?').join(',')})`).run(
    kind,
    ...ids,
  );
}

/** Thrown inside the preview transaction to force a rollback; never surfaced to a caller. */
const PREVIEW_ROLLBACK = Symbol('forget-preview-rollback');

/**
 * §4 invariant: forgetting an event deletes the event, every claim whose *only* source was that
 * event (a multi-source claim just loses this one source, via claim_sources' ON DELETE CASCADE on
 * events), and tombstones the event so a transcript rescan can't resurrect it (D32).
 */
function forgetEvent(db: Db, event: EventRow): Outcome {
  const orphanClaimIds = db
    .prepare(
      `SELECT c.id FROM claims c
       WHERE EXISTS (SELECT 1 FROM claim_sources cs WHERE cs.claim_id = c.id AND cs.event_id = ?)
         AND NOT EXISTS (SELECT 1 FROM claim_sources cs2 WHERE cs2.claim_id = c.id AND cs2.event_id != ?)`,
    )
    .pluck()
    .all(event.id, event.id) as string[];

  // H5 (forget preview honesty): claims that cite this event but keep at least one other source --
  // computed before anything is deleted, from the same claim_sources rows the orphan query above
  // already inspected.
  const citingClaimIds = db
    .prepare(`SELECT DISTINCT claim_id FROM claim_sources WHERE event_id = ?`)
    .pluck()
    .all(event.id) as string[];
  const orphanSet = new Set(orphanClaimIds);
  const survivingClaims = citingClaimIds.filter((cid) => !orphanSet.has(cid));

  // H5: other events (any session) sharing this one's exact content -- forget deletes this *item*,
  // not the text; a duplicate under a different event id is left untouched and should say so.
  const sameContentEvents = db
    .prepare(`SELECT id FROM events WHERE content_hash = ? AND id != ?`)
    .pluck()
    .all(event.content_hash, event.id) as string[];

  // Accesses have no FK (target_id is a free-form claim/event id), so the §4 "accesses targeting
  // deleted ids are deleted too" rule needs an explicit delete here.
  const accessTargets = [event.id, ...orphanClaimIds];
  db.prepare(`DELETE FROM accesses WHERE target_id IN (${accessTargets.map(() => '?').join(',')})`).run(
    ...accessTargets,
  );

  if (orphanClaimIds.length > 0) {
    db.prepare(`DELETE FROM claims WHERE id IN (${orphanClaimIds.map(() => '?').join(',')})`).run(
      ...orphanClaimIds,
    );
  }

  // H2: a pin/note on the event itself, or on a claim orphaned by this cascade, must not survive as
  // a dangling mark row once its target is gone.
  const marksDeleted = deleteMarksForTargets(db, [event.id, ...orphanClaimIds]);

  // D42: the event's own embedding, plus every orphaned claim's -- both are being deleted below.
  deleteEmbeddingsForTargets(db, 'event', [event.id]);
  deleteEmbeddingsForTargets(db, 'claim', orphanClaimIds);

  // D32: tombstone before the event row is gone -- appendEvent needs these fields to recognise a
  // future re-ingest attempt of the exact same logical event.
  db.prepare(
    `INSERT OR IGNORE INTO tombstones (session_id, source_ref, content_hash, created_at) VALUES (?, ?, ?, ?)`,
  ).run(event.session_id, event.source_ref, event.content_hash, nowIso());

  db.prepare(`DELETE FROM events WHERE id = ?`).run(event.id);

  return {
    kind: 'event',
    events: [event.id],
    claims: orphanClaimIds,
    marksAdded: [],
    marksDeleted,
    survivingClaims,
    sameContentEvents,
    sourceEvents: [],
    spoolTarget: { content: event.content, sourceRef: event.source_ref },
  };
}

/**
 * §4 invariant: forgetting a claim deletes the claim (its claim_sources cascade; any claim it
 * superseded has `superseded_by` nulled via ON DELETE SET NULL) and adds a `never_inject` hash mark
 * on each of its source events' content_hash (D32), so upsertClaims rejects any future claim that
 * cites one of those events -- the events themselves are left alone.
 */
function forgetClaim(db: Db, claim: ClaimRow): Outcome {
  const sourceEventIds = db
    .prepare(`SELECT event_id FROM claim_sources WHERE claim_id = ?`)
    .pluck()
    .all(claim.id) as string[];
  const hashes = Array.from(
    new Set(
      sourceEventIds.map((eid) => readEvent(db, eid)?.content_hash).filter((h): h is string => Boolean(h)),
    ),
  );

  db.prepare(`DELETE FROM accesses WHERE target_id = ?`).run(claim.id);

  // H2: any existing mark on the claim itself (e.g. a `pinned` note) must go -- deleted before the
  // hash: never_inject marks below are added, so it can never remove a mark forget() just added
  // (the hash: target_ids are never equal to claim.id anyway, but the ordering keeps the intent clear).
  const marksDeleted = deleteMarksForTargets(db, [claim.id]);

  // D42: the claim's own embedding -- the claim row itself is being deleted below.
  deleteEmbeddingsForTargets(db, 'claim', [claim.id]);

  const now = nowIso();
  const insertMark = db.prepare(
    `INSERT OR IGNORE INTO marks (target_id, kind, note, created_at) VALUES (?, 'never_inject', NULL, ?)`,
  );
  const marksAdded = hashes.map((h) => `hash:${h}`);
  for (const targetId of marksAdded) insertMark.run(targetId, now);

  db.prepare(`DELETE FROM claims WHERE id = ?`).run(claim.id);

  return {
    kind: 'claim',
    events: [],
    claims: [claim.id],
    marksAdded,
    marksDeleted,
    // H5: not applicable to a claim-kind forget -- no event is deleted, so nothing "survives losing
    // this source" and there's no "same content" to warn about.
    survivingClaims: [],
    sameContentEvents: [],
    sourceEvents: sourceEventIds,
    spoolTarget: null,
  };
}

/**
 * H5: the shared "forget is per item" honesty line, built from ForgetPlan.surviving_claims /
 * same_content_events. `null` when neither list has anything to say (the common case: nothing else
 * cites this event, and no other event has the same content).
 */
export function survivalNote(plan: ForgetPlan): string | null {
  const parts = [
    ...plan.same_content_events.map((id) => `event ${id} (same content)`),
    ...plan.surviving_claims.map((id) => `claim ${id} (cites other sources too)`),
  ];
  if (parts.length === 0) return null;
  return `Forget removes this item only; the same text may remain in: ${parts.join(', ')}`;
}

/**
 * Task 0: the claim-kind-forget preview honesty line companion to survivalNote -- forgetting a claim
 * never deletes the events it cites (only forgetting the event itself does); `null` for an event-kind
 * forget (plan.source_events is always [] there) or a claim with no sources (shouldn't happen, but
 * fails safe toward no note rather than a misleading empty list).
 */
export function claimSourceEventsNote(plan: ForgetPlan): string | null {
  if (plan.source_events.length === 0) return null;
  return `The source events that contain the original text remain; forget them individually if needed: ${plan.source_events.join(', ')}`;
}

function doForget(db: Db, id: string): Outcome {
  const event = readEvent(db, id);
  if (event) return forgetEvent(db, event);
  const claim = readClaim(db, id);
  if (claim) return forgetClaim(db, claim);
  throw new Error(`no claim or event with id ${id}`);
}

/**
 * The only delete path for events/claims (§9.5). `confirm=false` runs the exact same deletes inside a
 * transaction and rolls it back, so the preview's counts can never drift from what confirm actually
 * does. `confirm=true` commits, then runs FTS optimize + a WAL checkpoint (secure_delete, set in
 * openDb, has already zeroed the deleted pages) and erases any spool file holding the forgotten
 * event's content, so nothing recoverable is left on disk.
 */
export function forget(db: Db, id: string, opts: { confirm: boolean }): ForgetResult {
  let outcome: Outcome | undefined;
  const txn = db.transaction(() => {
    outcome = doForget(db, id);
    if (!opts.confirm) throw PREVIEW_ROLLBACK;
  });

  try {
    txn.immediate();
  } catch (err) {
    if (err !== PREVIEW_ROLLBACK) throw err;
  }

  const o = outcome!;

  // H8: once the delete transaction above has committed, nothing past this point is allowed to turn
  // a successful forget into a thrown error -- each cleanup step (FTS optimize x2, the WAL checkpoint,
  // the spool erase) runs in its own try/catch, independent of the others, so one failing can never
  // stop the rest from running or surface as an exception out of forget(). The paused-write guard
  // lives in memory_forget's tool wrapper (src/mcp/tools/forget.ts), which short-circuits to
  // { paused: true } before ever calling forget() when confirm is true.
  let checkpointed = true;
  let optimized = true;
  if (opts.confirm) {
    try {
      db.prepare(`INSERT INTO events_fts(events_fts) VALUES('optimize')`).run();
    } catch {
      // the row itself is already gone (secure_delete) regardless of FTS housekeeping -- surfaced via
      // `optimized: false` rather than thrown (H8: nothing past commit is allowed to turn a successful
      // forget into a thrown error).
      optimized = false;
    }
    try {
      db.prepare(`INSERT INTO claims_fts(claims_fts) VALUES('optimize')`).run();
    } catch {
      optimized = false;
    }
    try {
      // H8: wal_checkpoint(TRUNCATE) reports whether it actually completed rather than throwing --
      // `busy` is set when e.g. another connection holds an open read snapshot that blocks the
      // truncate. Checked explicitly (rather than assumed) and surfaced as `checkpointed`.
      const [row] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
      checkpointed = row ? row.busy === 0 : true;
    } catch {
      checkpointed = false;
    }
    if (o.spoolTarget) {
      try {
        eraseMatchingSpoolFiles(o.spoolTarget);
      } catch {
        // best effort -- a stray spool file left behind is not worse than the pre-forget state
      }
    }
  }

  return {
    deleted: { events: o.events.length, claims: o.claims.length, marks_deleted: o.marksDeleted },
    plan: {
      target: { kind: o.kind, id },
      events: o.events,
      claims: o.claims,
      marks_added: o.marksAdded,
      surviving_claims: o.survivingClaims,
      same_content_events: o.sameContentEvents,
      source_events: o.sourceEvents,
    },
    rebuilt: opts.confirm,
    checkpointed,
    optimized,
  };
}
