import { dbPath } from '../../config.js';
import { isPaused, PAUSED_TEXT } from '../../control/pause.js';
import { rebuild } from '../../control/rebuild.js';
import { nowIso } from '../../core/ids.js';
import { openDb } from '../../storage/db.js';

/**
 * `engram rebuild`: rebuilds `events_fts`/`claims_fts` from their source tables and recomputes every
 * claim's importance (§6.11/§7). Refuses while paused, before even opening the DB -- same pattern and
 * exact text as `engram import`/`engram forget --yes`.
 */
export function rebuildCommand(): number {
  if (isPaused()) {
    process.stderr.write(`${PAUSED_TEXT}\n`);
    return 1;
  }
  const db = openDb(dbPath());
  try {
    const result = rebuild(db, nowIso());
    process.stdout.write(
      `rebuilt: fts_checksum=${result.fts_checksum} importance_checksum=${result.importance_checksum}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
