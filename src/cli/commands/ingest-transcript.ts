import { dbPath, loadConfig } from '../../config.js';
import { projectFromCwd } from '../../core/project.js';
import { ingestTranscript } from '../../events/transcript.js';
import { openDb } from '../../storage/db.js';
import { HOOK_BUSY_TIMEOUT_MS, isEnoentError, runHook } from '../hook.js';
import { drainSpool } from '../spool.js';

/** Stop / PreCompact / SessionEnd hook: ingest new assistant turns from the transcript. */
export function ingestTranscriptCommand(): Promise<number> {
  return runHook('ingest-transcript', (input) => {
    if (!input.transcript_path) throw new Error('hook input has no transcript_path');
    const db = openDb(dbPath(), { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
    try {
      const { locked } = drainSpool(db);
      // Fix round 1 (Critical): a lock drainSpool just hit is almost certainly still held -- ingest
      // is offset-based (src/events/transcript.ts), so skipping it here costs nothing except a
      // slightly later ingest: the next successful hook picks up from the same `ingest_offset`.
      if (locked) return;
      try {
        ingestTranscript(db, {
          sessionId: input.session_id,
          transcriptPath: input.transcript_path,
          project: projectFromCwd(input.cwd),
          ingestToolResults: loadConfig().ingestToolResults,
        });
      } catch (err) {
        // Decision (live go-live): a transcript can legitimately not exist yet for a
        // session with no messages -- silent no-op, not even a hooks.log line.
        if (!isEnoentError(err)) throw err;
      }
    } finally {
      db.close();
    }
  });
}
