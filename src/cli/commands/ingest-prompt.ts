import { dbPath } from '../../config.js';
import { newId } from '../../core/ids.js';
import { projectFromCwd } from '../../core/project.js';
import { appendEvent } from '../../events/events.js';
import { ensureSession } from '../../events/sessions.js';
import { openDb } from '../../storage/db.js';
import { HOOK_BUSY_TIMEOUT_MS, runHook } from '../hook.js';
import { drainSpool, isLockError, spoolPrompt } from '../spool.js';
import type { HookInput } from '../hook.js';

function spoolThisPrompt(input: HookInput, text: string): void {
  spoolPrompt({
    session_id: input.session_id,
    cwd: input.cwd ?? null,
    transcript_path: input.transcript_path ?? null,
    prompt_id: input.prompt_id ?? null,
    prompt: text,
  });
}

/** UserPromptSubmit hook. Its stdout is injected into Claude's context, so it must print nothing. */
export function ingestPromptCommand(): Promise<number> {
  return runHook('ingest-prompt', (input) => {
    const text = input.prompt ?? input.user_input;
    if (!text || !text.trim()) return;

    // H6: openDb() itself can throw SQLITE_BUSY -- a held write lock blocks not just a later write
    // but the migration openDb runs internally (migrate() needs the write lock too) whenever this
    // database has a pending schema migration. Before this fix, that exception propagated straight
    // out of the handler to runHook's own catch, which only logs -- the prompt was silently dropped
    // instead of spooled. Open outside the try/finally below so a lock error here spools and returns
    // without ever reaching `db.close()` (there is no `db` to close).
    let db;
    try {
      db = openDb(dbPath(), { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
    } catch (err) {
      if (!isLockError(err)) throw err;
      spoolThisPrompt(input, text);
      return;
    }

    try {
      const project = projectFromCwd(input.cwd);
      // Fix round 1 (Critical): if drainSpool already hit the write lock, it's almost certainly still
      // held -- go straight to spooling this prompt instead of also paying ensureSession/appendEvent's
      // own busy-wait for an attempt that would very likely fail anyway.
      const { locked } = drainSpool(db);
      if (locked) {
        spoolThisPrompt(input, text);
        return;
      }
      try {
        ensureSession(db, { id: input.session_id, project, transcriptPath: input.transcript_path ?? null });
        appendEvent(db, {
          sessionId: input.session_id,
          role: 'user',
          content: text,
          project,
          sourceRef: input.prompt_id ?? newId(),
        });
      } catch (err) {
        // D26: a write-locked DB must not drop the prompt -- spool it for the next hook to drain.
        if (!isLockError(err)) throw err;
        spoolThisPrompt(input, text);
      }
    } finally {
      db.close();
    }
  });
}
