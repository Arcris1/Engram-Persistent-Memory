import { isExtractable } from './claims.js';
import { isInstructionLike } from '../core/detect.js';
import { truncateUtf16 } from '../core/text.js';
import type { EventKind, Role, Scope } from '../core/types.js';
import { rowToEvent, type RawEventRow } from '../events/events.js';
import type { SessionRow } from '../events/sessions.js';
import type { Db } from '../storage/db.js';

/** Pending-session event previews are capped more generously than search hits (§6.4). */
export const PENDING_CONTENT_CHARS = 4000;

export interface PendingEvent {
  id: string;
  ts: string;
  role: Role;
  kind: EventKind;
  scope: Scope;
  flags: string[];
  content: string;
  content_truncated: boolean;
  extractable: boolean;
  /**
   * F8 (D21 pattern, internal only): stored `instruction_like` flag OR recomputed over the full
   * (pre-truncation) content. Consumers (wrap.ts text output, the memory_pending tool's `warning`
   * tagging) use this; it is not part of the tool's public output schema itself.
   */
  instruction_like: boolean;
}

export interface PendingSession {
  session_id: string;
  project: string | null;
  started_at: string;
  consolidated_at: string | null;
  event_count: number;
  event_offset: number;
  events: PendingEvent[];
  events_truncated: boolean;
  /** F2: event_offset + events shown, when more events remain in this session (budget or paging); else null. */
  next_offset: number | null;
}

export interface PendingParams {
  session_id?: string;
  limit_sessions: number;
  include_consolidated: boolean;
  event_limit: number;
  event_offset: number;
  /** F2: output budget across the whole response; defaults to DEFAULT_MAX_CHARS. */
  max_chars?: number;
}

export interface ListPendingResult {
  sessions: PendingSession[];
  /** F2: true when the budget cut an in-progress session short or caused a later session to be omitted. */
  budget_exhausted: boolean;
}

export const DEFAULT_MAX_CHARS = 40000;

/**
 * F2: estimated rendered size of one pending event in the text output, used to stop accumulating
 * events once the response would exceed max_chars. We don't render the actual <memory> block to
 * measure it (that would mean rendering twice); instead each event is charged its (possibly
 * truncated) content length plus a flat allowance for the surrounding tag/attributes/warning text.
 */
const EVENT_SIZE_OVERHEAD = 200;

export function listPending(db: Db, p: PendingParams): ListPendingResult {
  const maxChars = p.max_chars ?? DEFAULT_MAX_CHARS;
  // F6: a session is pending when it has an event past its consolidated_seq high-water mark (never
  // consolidated = mark 0, so every event qualifies). include_consolidated bypasses the mark entirely
  // and lists every session with events, with all their events -- same as "seq > 0".
  const sessionRows = db
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE (@sessionId IS NULL OR s.id = @sessionId)
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.session_id = s.id
             AND e.seq > (CASE WHEN @includeConsolidated = 1 THEN 0 ELSE COALESCE(s.consolidated_seq, 0) END)
         )
       ORDER BY s.started_at ASC, s.id ASC
       LIMIT @limitSessions`,
    )
    .all({
      includeConsolidated: p.include_consolidated ? 1 : 0,
      sessionId: p.session_id ?? null,
      limitSessions: p.limit_sessions,
    }) as SessionRow[];

  const countStmt = db.prepare(`SELECT count(*) FROM events WHERE session_id = ? AND seq > ?`).pluck();
  const eventsStmt = db.prepare(
    `SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY ts ASC, seq ASC LIMIT ? OFFSET ?`,
  );

  const sessions: PendingSession[] = [];
  let usedChars = 0;
  let budgetExhausted = false;

  for (const s of sessionRows) {
    const seqThreshold = p.include_consolidated ? 0 : (s.consolidated_seq ?? 0);
    const eventCount = countStmt.get(s.id, seqThreshold) as number;
    const rawEvents = eventsStmt.all(s.id, seqThreshold, p.event_limit, p.event_offset) as RawEventRow[];

    const events: PendingEvent[] = [];
    let cutShort = false;
    for (const raw of rawEvents) {
      const e = rowToEvent(raw);
      const content = truncateUtf16(e.content, PENDING_CONTENT_CHARS);
      const size = content.length + EVENT_SIZE_OVERHEAD;
      const isVeryFirstEvent = sessions.length === 0 && events.length === 0;
      if (usedChars + size > maxChars && !isVeryFirstEvent) {
        cutShort = true;
        break;
      }
      usedChars += size;
      events.push({
        id: e.id,
        ts: e.ts,
        role: e.role,
        kind: e.kind,
        scope: e.scope,
        flags: e.flags,
        content,
        content_truncated: content.length < e.content.length,
        extractable: isExtractable(e),
        instruction_like: e.flags.includes('instruction_like') || isInstructionLike(e.content),
      });
    }

    if (events.length === 0 && rawEvents.length > 0) {
      // Budget exhausted before this session's first event fit: omit the session entirely.
      budgetExhausted = true;
      break;
    }

    const shown = events.length;
    const moreRemain = cutShort || p.event_offset + shown < eventCount;
    sessions.push({
      session_id: s.id,
      project: s.project,
      started_at: s.started_at,
      consolidated_at: s.consolidated_at,
      event_count: eventCount,
      event_offset: p.event_offset,
      events,
      events_truncated: moreRemain,
      next_offset: moreRemain ? p.event_offset + shown : null,
    });

    if (cutShort) {
      budgetExhausted = true;
      break;
    }
  }

  return { sessions, budget_exhausted: budgetExhausted };
}

export interface ResetClaimsResult {
  claims: number;
  sessions_reset: number;
  done: boolean;
}

const countClaims = (db: Db) => db.prepare(`SELECT count(*) FROM claims`).pluck().get() as number;
const countSessionsReset = (db: Db) =>
  db.prepare(`SELECT count(*) FROM sessions WHERE consolidated_at IS NOT NULL`).pluck().get() as number;

/** D-reset: only for `/consolidate --from-scratch`; marks (user intent) are untouched (§4). */
export function resetClaims(db: Db, confirm: boolean): ResetClaimsResult {
  if (!confirm) {
    // F8 (Minor): both counts read from one consistent snapshot, same as the confirm=true path.
    return db.transaction((): ResetClaimsResult => {
      return { claims: countClaims(db), sessions_reset: countSessionsReset(db), done: false };
    })();
  }

  return db.transaction((): ResetClaimsResult => {
    // F8 (Minor): counts computed inside the same transaction that performs the delete, so they can't
    // drift from what's actually removed by a write landing between a count and the delete.
    const claims = countClaims(db);
    const sessionsReset = countSessionsReset(db);
    // Accesses are deleted via a subquery against claims, so it must run before claims are gone.
    db.prepare(`DELETE FROM accesses WHERE target_id IN (SELECT id FROM claims)`).run();
    db.prepare(`DELETE FROM claims`).run(); // cascades claim_sources
    // Phase 6 review: claim embeddings are derived data keyed by claim id with no FK; drop them in the
    // same transaction so no orphan vectors survive the reset (event embeddings are untouched).
    db.prepare(`DELETE FROM embeddings WHERE target_kind = 'claim'`).run();
    db.prepare(
      `UPDATE sessions SET consolidated_at = NULL, consolidated_seq = NULL WHERE consolidated_at IS NOT NULL`,
    ).run();
    return { claims, sessions_reset: sessionsReset, done: true };
  })();
}
