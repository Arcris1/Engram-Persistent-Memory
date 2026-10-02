import { dbPath, loadConfig } from '../../config.js';
import { isPaused, PAUSED_TEXT } from '../../control/pause.js';
import { rebuild } from '../../control/rebuild.js';
import { nowIso } from '../../core/ids.js';
import { openDb } from '../../storage/db.js';

/**
 * `engram maintain [--embed]`: the scheduled (launchd/cron) upkeep command -- rebuild (§6.11/§7), then
 * `PRAGMA optimize` (lets SQLite refresh query-planner statistics) then `wal_checkpoint(TRUNCATE)`
 * (flushes and truncates the WAL). Refuses while paused, before even opening the DB, same as
 * `engram rebuild`: it performs the same writes `rebuild` does, plus a checkpoint.
 *
 * D42/Phase 6 Task 2: `--embed` backfills any missing/stale vectors first, to completion via the same embedAll()
 * loop `engram embed` uses. Unlike `engram embed` on its own, a maintain run is scheduled/unattended
 * and must not fail the whole maintenance pass just because embedding isn't enabled or isn't usable
 * right now (the common case: embedding is off by default) -- that case is reported on stdout, same
 * tone as the rest of this command's output, never stderr/exit 1.
 */
export async function maintainCommand(args: string[] = []): Promise<number> {
  if (isPaused()) {
    process.stderr.write(`${PAUSED_TEXT}\n`);
    return 1;
  }
  const doEmbed = args.includes('--embed');
  const db = openDb(dbPath());
  try {
    let embedNote = '';
    if (doEmbed) {
      // Any embedding/DB error here is logged and swallowed: it must never skip or fail the
      // rebuild/optimize/checkpoint steps below (an unattended run's primary job).
      try {
        // loaded only for --embed so plain `maintain` (and hooks) never load src/embed/*
        const [{ embedAll }, { sweepOrphanEmbeddings }, { tryLoadEmbedder }] = await Promise.all([
          import('../../embed/backfill.js'),
          import('../../embed/store.js'),
          import('../../embed/load.js'),
        ]);
        const { embedder, reason } = await tryLoadEmbedder(loadConfig());
        if (embedder) {
          sweepOrphanEmbeddings(db); // Phase 6 review: drop vectors whose source row is gone
          const result = await embedAll(db, embedder);
          embedNote = `, embedded ${result.embedded} (events=${result.by_kind.event}, claims=${result.by_kind.claim})`;
        } else {
          embedNote = `, embed skipped (${reason})`;
        }
      } catch (err) {
        process.stderr.write(`engram: maintain --embed failed: ${err instanceof Error ? err.message : String(err)}\n`);
        embedNote = ', embed failed';
      }
    }
    const result = rebuild(db, nowIso());
    db.pragma('optimize');
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
    // Unlike forget()'s H8 cleanup (where a failed checkpoint still leaves the delete itself final),
    // a missing/falsy pragma result here means we simply don't know whether the checkpoint completed
    // -- report checkpointed=false rather than optimistically claiming success.
    const checkpointed = checkpoint ? checkpoint.busy === 0 : false;
    process.stdout.write(
      `maintain: rebuilt (fts_checksum=${result.fts_checksum.slice(0, 12)}…, ` +
        `importance_checksum=${result.importance_checksum.slice(0, 12)}…), optimized, ` +
        `checkpointed=${checkpointed}${embedNote}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
