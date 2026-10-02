import { nowIso } from '../core/ids.js';
import type { Db } from '../storage/db.js';

export interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  project: string | null;
  transcript_path: string | null;
  ingest_offset: number;
  consolidated_at: string | null;
  /** F6: high-water mark -- the max events.seq at the time this session was last marked consolidated. */
  consolidated_seq: number | null;
}

export interface EnsureSessionInput {
  id: string;
  project?: string | null;
  transcriptPath?: string | null;
  startedAt?: string;
}

export function getSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function ensureSession(db: Db, input: EnsureSessionInput): SessionRow {
  // SET expressions read the *old* row, so ingest_offset compares against the previous transcript_path.
  db.prepare(
    `INSERT INTO sessions (id, started_at, project, transcript_path) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       project = COALESCE(sessions.project, excluded.project),
       transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
       ingest_offset = CASE
         WHEN excluded.transcript_path IS NOT NULL AND sessions.transcript_path IS NOT excluded.transcript_path THEN 0
         ELSE sessions.ingest_offset END`,
  ).run(input.id, input.startedAt ?? nowIso(), input.project ?? null, input.transcriptPath ?? null);
  return getSession(db, input.id)!;
}

export function setIngestOffset(db: Db, id: string, offset: number): void {
  db.prepare(`UPDATE sessions SET ingest_offset = ? WHERE id = ?`).run(offset, id);
}

/** SessionEnd hook: marks the session closed. A no-op if the session row doesn't exist. */
export function endSession(db: Db, id: string): void {
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(nowIso(), id);
}
