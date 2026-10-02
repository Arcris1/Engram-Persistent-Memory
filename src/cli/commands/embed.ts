import { dbPath, loadConfig } from '../../config.js';
import { isPaused, PAUSED_TEXT } from '../../control/pause.js';
import { embedAll } from '../../embed/backfill.js';
import { countMissingOrStale, sweepOrphanEmbeddings, type TargetKind } from '../../embed/store.js';
import { tryLoadEmbedder } from '../../embed/load.js';
import { openDb } from '../../storage/db.js';

const USAGE = 'usage: engram embed [--limit N]';

function parseFlags(args: string[]): { limit?: number } {
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      const raw = args[++i];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < 1) throw new Error(`--limit must be an integer >= 1 (got '${raw}')\n${USAGE}`);
      limit = n;
    } else {
      // Phase 6 review: a typo like `--lmit` must not silently run an uncapped backfill.
      throw new Error(`embed: unknown argument '${args[i]}'\n${USAGE}`);
    }
  }
  return { limit };
}

/**
 * `engram embed [--limit N]`: backfills vectors for events/claims with no embedding yet (or a stale
 * one), looping in batches (embedAll) of 500 rows per kind until nothing is missing; `--limit N` caps the total
 * embedded in this run. Prints the embedded and remaining counts. Refuses while paused, before even opening the DB -- same pattern as `engram rebuild`/`engram
 * import`. Exits 1 (without opening the DB) when embedding isn't usable right now (disabled, or
 * misconfigured/sha-mismatched -- loadEmbedder already logged the reason to stderr in that case).
 */
export async function embedCommand(args: string[]): Promise<number> {
  if (isPaused()) {
    process.stderr.write(`${PAUSED_TEXT}\n`);
    return 1;
  }
  const { limit } = parseFlags(args);
  const { embedder, reason } = await tryLoadEmbedder(loadConfig());
  if (!embedder) {
    process.stderr.write(`engram: embedding unavailable (${reason})\n`);
    return 1;
  }
  const db = openDb(dbPath());
  try {
    sweepOrphanEmbeddings(db); // Phase 6 review: drop vectors whose source row is gone (forget race backstop)
    const { embedded: total, by_kind: byKind } = await embedAll(db, embedder, { limit });
    const kinds: TargetKind[] = ['event', 'claim'];
    const remaining = kinds.reduce((n, k) => n + countMissingOrStale(db, k, embedder.model), 0);
    process.stdout.write(
      `embedded ${total} (events=${byKind.event}, claims=${byKind.claim}), remaining ${remaining}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
