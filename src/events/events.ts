import { detectScope } from '../core/detect.js';
import { sha256 } from '../core/hash.js';
import { newId, toIso } from '../core/ids.js';
import { processContent } from '../core/process.js';
import type { EventKind, Role, Scope } from '../core/types.js';
import type { Db } from '../storage/db.js';
import { ensureSession } from './sessions.js';

export interface AppendEventInput {
  sessionId: string;
  role: Role;
  content: string;
  kind?: EventKind;
  project?: string | null;
  ts?: string;
  scope?: Scope;
  /** D6: transcript line uuid / hook prompt_id; '' for memory_record. */
  sourceRef?: string;
  /**
   * G6: when set, `content` is already fully processed (redacted/capped at spool-write time) and
   * these are its final flags -- `processContent` is skipped entirely instead of re-running it.
   * Re-running redaction on already-redacted text (e.g. `[REDACTED:api_key]`) would find nothing to
   * redact and silently lose flags like `secret_redacted` that genuinely applied to the original
   * content. Used by `drainSpool`.
   */
  preProcessedFlags?: string[];
}

export interface AppendEventResult {
  id: string;
  inserted: boolean;
  /** D32: set (with id: '', inserted: false) when a tombstone blocked this insert -- see appendEvent. */
  tombstoned?: boolean;
}

export interface EventRow {
  id: string;
  ts: string;
  session_id: string;
  project: string | null;
  role: Role;
  kind: EventKind;
  content: string;
  content_hash: string;
  source_ref: string;
  scope: Scope;
  flags: string[];
}

export type RawEventRow = Omit<EventRow, 'flags'> & { seq: number; flags: string };

export function rowToEvent(raw: RawEventRow): EventRow {
  const { seq: _seq, flags, ...rest } = raw;
  return { ...rest, flags: JSON.parse(flags) as string[] };
}

export function readEvent(db: Db, id: string): EventRow | undefined {
  const raw = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as RawEventRow | undefined;
  return raw ? rowToEvent(raw) : undefined;
}

export function appendEvent(db: Db, input: AppendEventInput): AppendEventResult {
  if (!input.content.trim()) throw new Error('appendEvent: content is empty');
  const processed =
    input.preProcessedFlags !== undefined
      ? { content: input.content, flags: input.preProcessedFlags, scope: input.scope ?? detectScope(input.content) }
      : processContent(input.content, input.scope);
  const hash = sha256(processed.content);
  const sourceRef = input.sourceRef ?? '';
  const ts = toIso(input.ts);

  return db.transaction((): AppendEventResult => {
    const session = ensureSession(db, { id: input.sessionId, project: input.project ?? null, startedAt: ts });
    const eventProject = input.project ?? session.project;

    // D32: a tombstone means this exact event was deliberately forgotten -- a transcript rescan or
    // replayed hook must never resurrect it. Matches by (session_id, source_ref) when this insert has
    // a real source_ref (so redaction/detection drift can't dodge the guard, same reasoning as D27's
    // source_ref dedupe); falls back to (session_id, '', content_hash) for memory_record's sourceRef
    // === '' inserts, which have no source_ref to key on.
    const tombstoned =
      sourceRef !== ''
        ? db
            .prepare(`SELECT 1 FROM tombstones WHERE session_id = ? AND source_ref = ?`)
            .pluck()
            .get(input.sessionId, sourceRef)
        : db
            .prepare(`SELECT 1 FROM tombstones WHERE session_id = ? AND source_ref = '' AND content_hash = ?`)
            .pluck()
            .get(input.sessionId, hash);
    if (tombstoned) return { id: '', inserted: false, tombstoned: true };

    // D27: a real transcript-line uuid (or hook prompt_id) identifies one logical event regardless
    // of content -- redaction/detection changes over time can no longer create a duplicate. Only
    // the '' sourceRef used by memory_record keeps the old hash-based dedupe.
    if (sourceRef !== '') {
      const existingByRef = db
        .prepare(`SELECT id FROM events WHERE session_id = ? AND source_ref = ?`)
        .pluck()
        .get(input.sessionId, sourceRef) as string | undefined;
      if (existingByRef) return { id: existingByRef, inserted: false };
    }

    const inserted = db
      .prepare(
        `INSERT INTO events (id, ts, session_id, project, role, kind, content, content_hash, source_ref, scope, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, source_ref, content_hash) DO NOTHING
         RETURNING id`,
      )
      .get(
        newId(), ts, input.sessionId, eventProject, input.role, input.kind ?? 'message',
        processed.content, hash, sourceRef, processed.scope, JSON.stringify(processed.flags),
      ) as { id: string } | undefined;
    if (inserted) return { id: inserted.id, inserted: true };
    const existing = db
      .prepare(`SELECT id FROM events WHERE session_id = ? AND source_ref = ? AND content_hash = ?`)
      .pluck()
      .get(input.sessionId, sourceRef, hash) as string;
    return { id: existing, inserted: false };
  })();
}
