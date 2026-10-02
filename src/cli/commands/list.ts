import { dbPath } from '../../config.js';
import { listClaims, listEvents } from '../../control/list.js';
import { stripControlChars } from '../../core/text.js';
import { openDb } from '../../storage/db.js';

const DEFAULT_LIMIT = 20;

interface ListFlags {
  mode: 'claims' | 'events';
  limit: number;
  project?: string;
}

function parseFlags(args: string[]): ListFlags {
  let mode: ListFlags['mode'] = 'claims';
  let limit = DEFAULT_LIMIT;
  let project: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--claims') mode = 'claims';
    else if (a === '--events') mode = 'events';
    else if (a === '--limit') {
      const raw = args[++i];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n <= 0) throw new Error(`list: --limit must be a positive integer (got '${raw}')`);
      limit = n;
    } else if (a === '--project') project = args[++i];
  }
  return { mode, limit, project };
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function line(id: string, when: string, project: string | null, body: string): string {
  const projectPart = project ? `[${project}]  ` : '';
  // H8: stray ASCII control characters (e.g. a bare ESC) aren't whitespace, so collapseWs alone
  // wouldn't remove them from this one-line-per-row terminal output.
  return `${id}  ${when}  ${projectPart}${stripControlChars(collapseWs(body))}`;
}

/**
 * `engram list [--claims|--events] [--limit N] [--project P]`: default claims, limit 20, active
 * claims only. One plain line per row: `id  recorded_at  [project]  statement` (events: `id  ts
 * [project]  content`).
 */
export function listCommand(args: string[]): number {
  const { mode, limit, project } = parseFlags(args);
  const db = openDb(dbPath());
  try {
    if (mode === 'claims') {
      for (const { claim: c } of listClaims(db, { project, limit })) {
        process.stdout.write(`${line(c.id, c.recorded_at, c.project, c.statement)}\n`);
      }
    } else {
      for (const { event: e } of listEvents(db, { project, limit })) {
        process.stdout.write(`${line(e.id, e.ts, e.project, e.content)}\n`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
