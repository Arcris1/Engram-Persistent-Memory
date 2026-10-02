import { computeImportance, recomputeImportanceFor } from '../control/importance.js';
import { isInstructionLike } from '../core/detect.js';
import { newId, nowIso } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { normalizeWhitespace } from '../core/text.js';
import type { Scope } from '../core/types.js';
import { readEvent, type EventRow } from '../events/events.js';
import type { Db } from '../storage/db.js';

export const PREDICATE_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_EXCERPT_CHARS = 300;
export const MIN_EXCERPT_CHARS = 8;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_OBJECT_CHARS = 500;
export const MAX_STATEMENT_CHARS = 500;

export interface ClaimSourceInput {
  event_id: string;
  excerpt: string;
}

export interface ClaimInput {
  subject: string;
  predicate: string;
  object: string;
  statement: string;
  scope: Scope;
  confidence: number;
  valid_from?: string | null;
  valid_to?: string | null;
  /** undefined/null -> global claim (project IS NULL). */
  project?: string | null;
  sources: ClaimSourceInput[];
  supersedes?: string;
}

export interface UpsertClaimsInput {
  claims: ClaimInput[];
  mark_session_consolidated?: string;
  /**
   * Phase 5 Task 3 fix round 1: injectable "now" for `recorded_at` / `consolidated_at`, defaulting to
   * `nowIso()` (existing behaviour unchanged). Lets a deterministic caller (the §11 eval harness) seed
   * claims with a fixed `recorded_at` instead of the real wall clock, so recency scoring and the
   * eval's output are reproducible across runs.
   */
  now?: string;
}

export interface UpsertClaimsResult {
  inserted: string[];
  merged: string[];
  superseded: string[];
  rejected: { index: number; reason: string }[];
  consolidated: string | null;
}

export interface ClaimRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  statement: string;
  scope: Scope;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  superseded_by: string | null;
  status: 'active' | 'superseded' | 'retracted';
  importance: number;
  access_count: number;
  last_accessed: string | null;
  project: string | null;
  flags: string[];
}

export type RawClaimRow = Omit<ClaimRow, 'flags'> & { seq: number; flags: string };

export function rowToClaim(raw: RawClaimRow): ClaimRow {
  const { seq: _seq, flags, ...rest } = raw;
  return { ...rest, flags: JSON.parse(flags) as string[] };
}

export function readClaim(db: Db, id: string): ClaimRow | undefined {
  const raw = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id) as RawClaimRow | undefined;
  return raw ? rowToClaim(raw) : undefined;
}

export function claimSources(db: Db, claimId: string): { event_id: string; excerpt: string | null }[] {
  return db
    .prepare(`SELECT event_id, excerpt FROM claim_sources WHERE claim_id = ?`)
    .all(claimId) as { event_id: string; excerpt: string | null }[];
}

/** D23: a flagged event can be cited only if it is the user's own words. */
export function isExtractable(event: EventRow): boolean {
  const flagged = event.flags.includes('instruction_like') || isInstructionLike(event.content);
  if (!flagged) return true;
  if (event.role !== 'user') return false;
  return event.kind === 'explicit_remember' || (event.kind === 'message' && !event.session_id.startsWith('mcp-'));
}

/** undefined/null/'' -> null; unparseable -> throws (caller turns this into a per-claim rejection). */
function toIsoOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date '${value}'`);
  return d.toISOString();
}

const SUBJECT_PROJECT_RE = /^project:(.+)$/i;

/**
 * F3: when `claim.project` is undefined (not explicitly supplied, including explicit `null`), infer
 * it: a "project:<name>" subject implies that project; otherwise, for any subject but 'user', every
 * cited event sharing the same non-null project implies that project. Falls back to global (null).
 * An explicit `null` always stays global.
 */
function defaultProject(claim: ClaimInput, events: EventRow[]): string | null {
  if (claim.project !== undefined) return claim.project;
  const m = SUBJECT_PROJECT_RE.exec(claim.subject);
  if (m) return m[1]!.trim();
  if (claim.subject !== 'user') {
    const first = events[0]?.project ?? null;
    if (first !== null && events.every((e) => e.project === first)) return first;
  }
  return null;
}

type ProcessResult =
  | { kind: 'inserted'; id: string; supersededId: string | null }
  | { kind: 'merged'; id: string; supersededId: string | null };

function processClaim(db: Db, claim: ClaimInput, now: string): ProcessResult {
  if (!claim.subject.trim() || !claim.object.trim() || !claim.statement.trim()) {
    throw new Error('empty subject, object or statement');
  }
  // G4: a subject is rendered verbatim into the profile's `[subject · predicate · id]` suffix; a
  // control character (including a bare newline) there could otherwise forge extra lines/frames in
  // that injected block. Rejected outright rather than silently stripped.
  if (/[\u0000-\u001f\u007f]/.test(claim.subject)) {
    throw new Error('subject contains control characters');
  }
  if (!PREDICATE_RE.test(claim.predicate)) {
    throw new Error(`invalid predicate '${claim.predicate}' (use snake_case)`);
  }
  const validFrom = toIsoOrNull(claim.valid_from);
  const validTo = toIsoOrNull(claim.valid_to);
  // F8 (Minor): both present (explicitly supplied; valid_from's event-ts default is computed later
  // and isn't second-guessed here) and out of order.
  if (validFrom !== null && validTo !== null && validTo < validFrom) {
    throw new Error('valid_to is before valid_from');
  }
  if (
    claim.subject.length > MAX_SUBJECT_CHARS ||
    claim.object.length > MAX_OBJECT_CHARS ||
    claim.statement.length > MAX_STATEMENT_CHARS
  ) {
    throw new Error('subject, object or statement too long');
  }

  if (claim.sources.length === 0) throw new Error('no sources');

  const events: EventRow[] = [];
  for (const src of claim.sources) {
    const event = readEvent(db, src.event_id);
    if (!event) throw new Error(`unknown event ${src.event_id}`);
    // D32: forgetting a claim marks its source events' content hash never_inject so a claim can't be
    // re-derived by citing the same event again (the event itself survives a claim-forget, unlike an
    // event-forget which deletes the event row outright and so fails the `!event` check above instead).
    const forgotten = db
      .prepare(`SELECT 1 FROM marks WHERE target_id = ? AND kind = 'never_inject'`)
      .pluck()
      .get(`hash:${event.content_hash}`);
    if (forgotten) throw new Error(`event ${src.event_id} was forgotten`);
    if (src.excerpt.length > MAX_EXCERPT_CHARS) throw new Error('excerpt longer than 300 characters');
    const normExcerpt = normalizeWhitespace(src.excerpt);
    // F8 (Minor): checked before the substring match, so a too-short excerpt never surfaces as a
    // confusing "not found" (it's rejected for being too short to usefully cite, not for missing).
    if (normExcerpt.length < MIN_EXCERPT_CHARS) throw new Error('excerpt shorter than 8 characters');
    if (!normalizeWhitespace(event.content).includes(normExcerpt)) {
      throw new Error(`excerpt not found in event ${src.event_id}`);
    }
    if (!isExtractable(event)) {
      throw new Error(`event ${src.event_id} is instruction-like and not the user's own words`);
    }
    events.push(event);
  }

  if (claim.supersedes) {
    const target = readClaim(db, claim.supersedes);
    if (!target || target.status !== 'active') {
      throw new Error(`superseded claim ${claim.supersedes} not found or not active`);
    }
  }

  // Text hygiene (§3): redact secrets, flag instruction-like statements.
  const redSubject = redactSecrets(claim.subject);
  const redObject = redactSecrets(claim.object);
  const redStatement = redactSecrets(claim.statement);
  const flags: string[] = [];
  if (redSubject.types.length > 0 || redObject.types.length > 0 || redStatement.types.length > 0) {
    flags.push('secret_redacted');
  }
  // G4: the subject is part of the instruction-like check too (a benign statement/object with an
  // injected subject must still be flagged).
  if (isInstructionLike(`${redSubject.text}\n${redStatement.text}\n${redObject.text}`)) flags.push('instruction_like');

  const project = defaultProject(claim, events);
  const minEventTs = events.reduce((min, e) => (e.ts < min ? e.ts : min), events[0]!.ts);
  const finalValidFrom = validFrom ?? minEventTs;
  const citesExplicitRemember = events.some((e) => e.kind === 'explicit_remember');

  // F5 (I5 + Minor): duplicate merge requires an active claim with the same subject/predicate/object/
  // project/scope, and excludes claims flagged instruction_like -- a clean restatement of a flagged
  // claim inserts a new row rather than silently merging into (and inheriting the framing concerns
  // of) the flagged one.
  // Task 0: also excludes claims flagged `imported` -- merging a fresh, locally-sourced restatement
  // into an imported claim would keep it stuck out of the profile (imported claims stay excluded
  // until memory_pin, D34) even though this new citation is a genuine local one; inserting a new,
  // non-imported row instead makes a fresh restatement profile-eligible on its own merits.
  const dupId = db
    .prepare(
      `SELECT id FROM claims
       WHERE status = 'active' AND lower(subject) = lower(?) AND lower(predicate) = lower(?)
         AND lower(object) = lower(?) AND project IS ? AND scope = ?
         AND NOT EXISTS (SELECT 1 FROM json_each(flags) WHERE value IN ('instruction_like', 'imported'))`,
    )
    .pluck()
    .get(redSubject.text, claim.predicate, redObject.text, project, claim.scope) as string | undefined;

  if (dupId) {
    const insertSrc = db.prepare(
      `INSERT OR IGNORE INTO claim_sources (claim_id, event_id, excerpt) VALUES (?, ?, ?)`,
    );
    for (const src of claim.sources) insertSrc.run(dupId, src.event_id, src.excerpt);
    db.prepare(`UPDATE claims SET confidence = max(confidence, ?) WHERE id = ?`).run(claim.confidence, dupId);
    // J1 (one importance scale): normalize the merge target onto the §7 formula via
    // recomputeImportanceFor instead of an ad-hoc `max(importance, 0.8)` bump -- recomputeImportanceFor
    // re-derives explicitRemember from claim_sources (just updated above), so a newly cited
    // explicit_remember source still floors this claim at 0.8 the same way the old bump did, while
    // every claim's importance -- merged or not -- stays on the one §7 formula scale instead of
    // accumulating ad-hoc bumps.
    recomputeImportanceFor(db, [dupId], now);
    // F5: a merge can still carry a supersedes -- apply it to the target claim (not the merge
    // destination itself, which is already active and would otherwise self-supersede).
    let supersededId: string | null = null;
    if (claim.supersedes && claim.supersedes !== dupId) {
      db.prepare(
        `UPDATE claims SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?) WHERE id = ?`,
      ).run(dupId, finalValidFrom, claim.supersedes);
      supersededId = claim.supersedes;
    }
    return { kind: 'merged', id: dupId, supersededId };
  }

  const id = newId();
  const recordedAt = now;
  // J1 (one importance scale): a freshly-inserted claim starts on the same §7 formula every later
  // recompute uses (usedCount=0, pinned=false here -- a claim can't be pinned before it exists), not
  // the old ad-hoc 0.5/0.8 insert-time constants. explicitRemember still floors it at 0.8 (§5B).
  const importance = computeImportance({ usedCount: 0, pinned: false, explicitRemember: citesExplicitRemember });

  db.prepare(
    `INSERT INTO claims
       (id, subject, predicate, object, statement, scope, confidence, valid_from, valid_to, recorded_at, status, importance, project, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id, redSubject.text, claim.predicate, redObject.text, redStatement.text, claim.scope, claim.confidence,
    finalValidFrom, validTo, recordedAt, importance, project, JSON.stringify(flags),
  );

  const insertSrc = db.prepare(`INSERT INTO claim_sources (claim_id, event_id, excerpt) VALUES (?, ?, ?)`);
  for (const src of claim.sources) insertSrc.run(id, src.event_id, src.excerpt);

  let supersededId: string | null = null;
  if (claim.supersedes) {
    db.prepare(
      `UPDATE claims SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?) WHERE id = ?`,
    ).run(id, finalValidFrom, claim.supersedes);
    supersededId = claim.supersedes;
  }

  return { kind: 'inserted', id, supersededId };
}

/**
 * F4: SQLite error codes that indicate a transient/environmental failure (lock contention, I/O,
 * disk full, corruption, read-only, can't-open, out-of-memory) rather than a problem with the claim
 * itself. These must propagate out of upsertClaims as a thrown error, not be absorbed into a
 * per-claim rejection -- the caller needs to know the whole batch may not have been attempted.
 */
const RETRYABLE_SQLITE_PREFIXES = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_CORRUPT',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  'SQLITE_NOMEM',
];

function isRetryableSqliteError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_SQLITE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export function upsertClaims(db: Db, input: UpsertClaimsInput): UpsertClaimsResult {
  if (input.mark_session_consolidated) {
    const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).pluck().get(input.mark_session_consolidated);
    if (!exists) throw new Error(`unknown session ${input.mark_session_consolidated}`);
  }

  // F4: IMMEDIATE takes the write lock up front instead of on first write, so a competing writer is
  // detected (and surfaced as a thrown SQLITE_BUSY/LOCKED error) before any per-claim work starts.
  // Phase 5 Task 3 fix round 1: a single `now`, resolved once (real wall clock unless the caller
  // injected one), is reused for every claim's `recorded_at` and for `consolidated_at` in this call --
  // same default behaviour as the previous per-call `nowIso()` reads, just deterministic when `now`
  // is supplied.
  const now = input.now ?? nowIso();
  return db
    .transaction((): UpsertClaimsResult => {
      const inserted: string[] = [];
      const merged: string[] = [];
      const superseded: string[] = [];
      const rejected: { index: number; reason: string }[] = [];

      input.claims.forEach((claim, index) => {
        try {
          // Nested transaction (SAVEPOINT): a throw here rolls back only this claim.
          const result = db.transaction(() => processClaim(db, claim, now))();
          if (result.kind === 'inserted') {
            inserted.push(result.id);
          } else {
            merged.push(result.id);
          }
          if (result.supersededId) superseded.push(result.supersededId);
        } catch (err) {
          if (isRetryableSqliteError(err)) throw err;
          rejected.push({ index, reason: (err as Error).message });
        }
      });

      let consolidated: string | null = null;
      if (input.mark_session_consolidated) {
        // F6: consolidated_seq is the high-water mark -- the newest event seq this mark has seen.
        // listPending uses it so a session only reappears once a later event is appended.
        db.prepare(
          `UPDATE sessions SET consolidated_at = ?,
             consolidated_seq = (SELECT max(seq) FROM events WHERE session_id = ?)
           WHERE id = ?`,
        ).run(now, input.mark_session_consolidated, input.mark_session_consolidated);
        consolidated = input.mark_session_consolidated;
      }

      return { inserted, merged, superseded, rejected, consolidated };
    })
    .immediate();
}
