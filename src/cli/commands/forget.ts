import type { ForgetPlan, ForgetResult } from '../../control/forget.js';
import { claimSourceEventsNote, forget, survivalNote } from '../../control/forget.js';
import { dataDir, dbPath } from '../../config.js';
import { isPaused, PAUSED_TEXT } from '../../control/pause.js';
import { openDb } from '../../storage/db.js';

function formatPreview(result: ForgetResult): string {
  const plan: ForgetPlan = result.plan;
  const lines = [
    `would forget ${plan.target.kind} ${plan.target.id}:`,
    `  events: ${result.deleted.events}`,
    `  claims: ${result.deleted.claims}`,
  ];
  if (plan.marks_added.length > 0) lines.push(`  marks added: ${plan.marks_added.join(', ')}`);
  const note = survivalNote(plan);
  if (note) lines.push(`  ${note}`);
  const sourceNote = claimSourceEventsNote(plan);
  if (sourceNote) lines.push(`  ${sourceNote}`);
  lines.push('re-run with --yes to delete');
  return `${lines.join('\n')}\n`;
}

function formatConfirmed(result: ForgetResult): string {
  // H8: checkpointed=false means the delete itself fully succeeded (secure_delete already zeroed the
  // freed pages at commit) but the WAL couldn't be flushed/truncated right now -- say so rather than
  // silently reporting the same "forgot" line either way.
  const checkpointNote = result.checkpointed
    ? ''
    : 'Note: the WAL could not be fully checkpointed right now (likely another open connection); the deletion is final, but the WAL file may still hold its pre-image until a later checkpoint.\n';
  // Task 0: same reasoning as checkpointNote -- the deletion is already final either way.
  const optimizeNote = result.optimized
    ? ''
    : 'Note: an FTS optimize step failed after the delete committed; the deletion is final, but a leftover indexed term may remain until a later optimize succeeds.\n';
  return (
    `forgot ${result.plan.target.kind} ${result.plan.target.id}: deleted ${result.deleted.events} event(s), ${result.deleted.claims} claim(s)\n` +
    checkpointNote +
    optimizeNote +
    `Note: existing export files (e.g. in ${dataDir()}) still contain this content; delete them if needed.\n`
  );
}

/**
 * `engram forget <id> [--yes]`: previews what `memory_forget` would delete; only deletes with
 * `--yes`. Paused refuses `--yes` before opening the DB, same exact text as every other guarded write.
 */
export function forgetCommand(args: string[]): number {
  const confirm = args.includes('--yes');
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) throw new Error('forget: usage: engram forget <id> [--yes]');

  if (confirm && isPaused()) {
    process.stderr.write(`${PAUSED_TEXT}\n`);
    return 1;
  }

  const db = openDb(dbPath());
  try {
    const result = forget(db, id, { confirm });
    process.stdout.write(confirm ? formatConfirmed(result) : formatPreview(result));
    return 0;
  } finally {
    db.close();
  }
}
