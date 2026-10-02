import { formatProfileBlock, selectProfile } from '../../claims/profile.js';
import { dbPath } from '../../config.js';
import { projectFromCwd } from '../../core/project.js';
import { ensureSession } from '../../events/sessions.js';
import { openDb } from '../../storage/db.js';
import { HOOK_BUSY_TIMEOUT_MS, logHookError, runHook } from '../hook.js';
import { drainSpool } from '../spool.js';

/**
 * SessionStart hook. The ONLY hook allowed to write stdout: its output is injected into Claude's
 * context as the memory profile. Any error anywhere in here must still produce no stdout at all.
 *
 * G1: the profile read (selectProfile/formatProfileBlock) runs FIRST and unconditionally -- it's a
 * plain read, so it succeeds even while another connection holds the write lock (WAL readers are
 * never blocked by a writer). Session bookkeeping (ensureSession, drainSpool) runs afterward in its
 * own try/catch so a write-lock failure there can never suppress the profile that was already read.
 */
export function sessionStartCommand(): Promise<number> {
  return runHook(
    'session-start',
    (input) => {
      const db = openDb(dbPath(), { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
      try {
        const project = projectFromCwd(input.cwd);
        const profile = formatProfileBlock(selectProfile(db, { project }));
        try {
          ensureSession(db, { id: input.session_id, project, transcriptPath: input.transcript_path ?? null });
          drainSpool(db);
        } catch (err) {
          logHookError('session-start', err);
        }
        return profile;
      } finally {
        db.close();
      }
    },
    { allowStdout: true },
  );
}
