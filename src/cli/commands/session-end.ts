import { dbPath, loadConfig } from '../../config.js';
import { projectFromCwd } from '../../core/project.js';
import { endSession, ensureSession } from '../../events/sessions.js';
import { ingestTranscript } from '../../events/transcript.js';
import { openDb } from '../../storage/db.js';
import { HOOK_BUSY_TIMEOUT_MS, isEnoentError, runHook } from '../hook.js';
import { drainSpool } from '../spool.js';

/**
 * SessionEnd hook: closes the session and ingests any remaining transcript. Always silent.
 *
 * G2: drainSpool runs first; if it hits the write lock, the whole hook backs off immediately --
 * ensureSession/ingest/endSession are all skipped (the lock is almost certainly still held, so
 * attempting any of them would just pay another busy-wait for nothing), leaving ended_at unchanged
 * and the spool backlog untouched for the next hook to pick up. When not locked, ingest runs inside
 * its own try/catch so a transcript-ingest failure can never prevent endSession from running; the
 * captured error is rethrown afterward so it still reaches hooks.log (as a one-line lock message, see
 * G6, when it is a lock error) instead of being silently swallowed.
 */
export function sessionEndCommand(): Promise<number> {
  return runHook('session-end', (input) => {
    const db = openDb(dbPath(), { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
    try {
      const { locked } = drainSpool(db);
      if (locked) return;

      const project = projectFromCwd(input.cwd);
      ensureSession(db, { id: input.session_id, project, transcriptPath: input.transcript_path ?? null });

      let ingestErr: unknown;
      if (input.transcript_path) {
        try {
          ingestTranscript(db, {
            sessionId: input.session_id,
            transcriptPath: input.transcript_path,
            project,
            ingestToolResults: loadConfig().ingestToolResults,
          });
        } catch (err) {
          // Decision (live go-live): a transcript can legitimately not exist yet for a
          // session with no messages -- silent no-op, not even a hooks.log line.
          if (!isEnoentError(err)) ingestErr = err;
        }
      }

      endSession(db, input.session_id);
      if (ingestErr !== undefined) throw ingestErr;
    } finally {
      db.close();
    }
  });
}
