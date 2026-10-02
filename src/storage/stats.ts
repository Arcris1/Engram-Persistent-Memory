import fs from 'node:fs';
import * as z from 'zod';
import type { Db } from './db.js';

export const StatsSchema = z.object({
  db_path: z.string(),
  db_bytes: z.number(),
  schema_version: z.number(),
  events: z.number(),
  sessions: z.number(),
  unconsolidated_sessions: z.number(),
  claims: z.object({ active: z.number(), superseded: z.number(), retracted: z.number() }),
  oldest_event: z.string().nullable(),
  newest_event: z.string().nullable(),
  flagged: z.object({ instruction_like: z.number(), secret_redacted: z.number(), truncated: z.number() }),
});
export type Stats = z.infer<typeof StatsSchema>;

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function getStats(db: Db, dbFile: string): Stats {
  const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;
  const flagged = (flag: string) =>
    count(`SELECT count(*) FROM events WHERE EXISTS (SELECT 1 FROM json_each(events.flags) WHERE value = ?)`, flag);
  const claims = (status: string) => count(`SELECT count(*) FROM claims WHERE status = ?`, status);
  const range = db.prepare(`SELECT min(ts) AS oldest, max(ts) AS newest FROM events`).get() as {
    oldest: string | null;
    newest: string | null;
  };
  return {
    db_path: dbFile,
    db_bytes: fileBytes(dbFile) + fileBytes(`${dbFile}-wal`),
    schema_version: db.pragma('user_version', { simple: true }) as number,
    events: count(`SELECT count(*) FROM events`),
    sessions: count(`SELECT count(*) FROM sessions`),
    unconsolidated_sessions: count(`SELECT count(*) FROM sessions WHERE consolidated_at IS NULL`),
    claims: { active: claims('active'), superseded: claims('superseded'), retracted: claims('retracted') },
    oldest_event: range.oldest,
    newest_event: range.newest,
    flagged: {
      instruction_like: flagged('instruction_like'),
      secret_redacted: flagged('secret_redacted'),
      truncated: flagged('truncated'),
    },
  };
}

export function formatStats(s: Stats): string {
  return [
    `engram — ${s.db_path}`,
    `  schema v${s.schema_version}, ${s.db_bytes} bytes`,
    `  events:    ${s.events} (oldest ${s.oldest_event ?? '—'}, newest ${s.newest_event ?? '—'})`,
    `  sessions:  ${s.sessions} (${s.unconsolidated_sessions} unconsolidated)`,
    `  claims:    ${s.claims.active} active, ${s.claims.superseded} superseded, ${s.claims.retracted} retracted`,
    `  flagged:   ${s.flagged.instruction_like} instruction_like, ${s.flagged.secret_redacted} secret_redacted, ${s.flagged.truncated} truncated`,
  ].join('\n');
}
