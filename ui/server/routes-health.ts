import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Route } from './context.js';
import { dataDir, doctorReportAsync, getStats, isPaused, VERSION, type DoctorHook, type DoctorReport } from './core.js';
import { semanticStatus } from './shape.js';
import type { Health } from './types.js';

const CACHE_MS = 30_000;

const LABELS: Record<string, string> = {
  SessionStart: 'When a session starts',
  UserPromptSubmit: 'When you send a message',
  Stop: 'When Claude replies',
  PreCompact: 'Before context is compacted',
  SessionEnd: 'When a session ends',
};

/** The "memory tools" row: when the check did not run, a plain reason (nothing more for a deliberate skip). */
function memoryTools(r: DoctorReport | null): Health['memoryTools'] {
  if (!r) return { checked: false, ok: false, detail: 'Claude Code did not answer.' };
  if (r.mcp.checked) return { checked: true, ok: r.mcp.registered, detail: r.mcp.detail };
  return { checked: false, ok: false, detail: r.mcp.detail.startsWith('skipped') ? '' : 'Claude Code did not answer.' };
}

/** One plain-words problem per hook, or null when it is working. */
function problemOf(h: DoctorHook): string | null {
  if (!h.installed) return 'not installed';
  if (h.detail) return "its command could not be read";
  if (h.node === 'missing') return 'the Node program it uses is missing';
  if (h.root === 'missing') return 'the engram install it points to is missing';
  if (h.nativeModule === 'failed') return 'the database module does not load';
  return null;
}

/** Mode bits of the database file: true when no group or other permission is set. */
function ownerOnly(file: string): boolean {
  try {
    return (fs.statSync(file).mode & 0o077) === 0;
  } catch {
    return true;
  }
}

/** mtime (ISO) of the newest `backup-*.db` in the data directory, or null. */
function newestBackup(): string | null {
  let newest = 0;
  try {
    const dir = dataDir();
    for (const name of fs.readdirSync(dir)) {
      if (!/^backup-.*\.db$/.test(name)) continue;
      const t = fs.statSync(path.join(dir, name)).mtimeMs;
      if (t > newest) newest = t;
    }
  } catch {
    /* no data dir: no backups */
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}

export function healthRoutes(): Route[] {
  // The doctor report shells out to `claude mcp get` (asynchronously, with a timeout), so its result is kept for
  // 30 s and at most one computation runs at a time: concurrent requests share the same promise.
  let cached: { at: number; report: DoctorReport | null } | undefined;
  let running: Promise<DoctorReport | null> | undefined;
  const report = async (ctx: Ctx): Promise<DoctorReport | null> => {
    const t = ctx.now().getTime();
    if (cached && t - cached.at < CACHE_MS && t >= cached.at) return cached.report;
    running ??= (async () => {
      let r: DoctorReport | null = null;
      try {
        r = await doctorReportAsync(ctx.doctorOpts);
      } catch {
        r = null; // e.g. an unreadable settings.json: the page still loads, the checks say so
      }
      cached = { at: t, report: r };
      return r;
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const health = async (ctx: Ctx): Promise<Health> => {
    const r = await report(ctx);
    const stats = getStats(ctx.db, ctx.dbFile);
    const search = semanticStatus(ctx.db);
    return {
      version: VERSION,
      paused: isPaused(),
      stats,
      hooks: r
        ? r.hooks.map((h) => {
            const problem = problemOf(h);
            return { event: h.event, label: LABELS[h.event] ?? h.event, ok: problem === null, problem };
          })
        : Object.entries(LABELS).map(([event, label]) => ({ event, label, ok: false, problem: 'could not be checked' })),
      waiting: r?.spool.backlog ?? 0,
      memoryTools: memoryTools(r),
      search: { semantic: search.enabled, embedded: search.embedded },
      hookErrors: { last24h: r?.hookErrors.last24h ?? 0 },
      storage: { path: ctx.dbFile, bytes: stats.db_bytes, ownerOnly: ownerOnly(ctx.dbFile), newestBackup: newestBackup(), schema: stats.schema_version },
    };
  };
  return [{ method: 'GET', match: /^\/api\/health$/, handle: (ctx) => health(ctx) }];
}
