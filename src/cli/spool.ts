import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';
import { newId, nowIso } from '../core/ids.js';
import { processContent } from '../core/process.js';
import { projectFromCwd } from '../core/project.js';
import { appendEvent } from '../events/events.js';
import type { Db } from '../storage/db.js';

/**
 * D26: when a hook can't get the write lock in time, it spools instead of silently dropping the
 * prompt. The spool holds already-redacted content at rest (never raw secrets on disk), 0600 files
 * in a 0700 directory, and is drained by the next hook that gets a clean write.
 */
export function spoolDir(): string {
  const dir = path.join(dataDir(), 'spool');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** True for better-sqlite3's SQLITE_BUSY / SQLITE_LOCKED errors (detected via `err.code`, never by message). */
export function isLockError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

export interface SpoolPromptInput {
  session_id: string;
  cwd?: string | null;
  transcript_path?: string | null;
  prompt_id?: string | null;
  /** Raw prompt text; redacted and capped here so the spool file never holds a raw secret. */
  prompt: string;
}

interface SpoolRecord {
  session_id: string;
  cwd: string | null;
  transcript_path: string | null;
  prompt_id: string | null;
  ts: string;
  content: string;
  /** G6: the flags processContent produced for `content` (e.g. `secret_redacted`), carried through
   * drain so they aren't lost by re-running redaction on already-redacted text. Optional for
   * backward compatibility with spool files written before this field existed. */
  flags?: string[];
}

/** Writes an already-redacted, capped spool record. Mode 0600, in the 0700 spool directory. */
export function spoolPrompt(input: SpoolPromptInput): void {
  const dir = spoolDir();
  const ts = nowIso();
  const processed = processContent(input.prompt);
  const record: SpoolRecord = {
    session_id: input.session_id,
    cwd: input.cwd ?? null,
    transcript_path: input.transcript_path ?? null,
    prompt_id: input.prompt_id ?? null,
    ts,
    content: processed.content,
    flags: processed.flags,
  };
  const name = `${ts}-${newId()}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(record), { mode: 0o600 });
}

/** `undefined`, `null` (our own writer's explicit "not set") and `string` are all valid; anything else is corrupt. */
const isNullableString = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || typeof v === 'string';

function isSpoolRecord(value: unknown): value is SpoolRecord {
  const v = value as Partial<SpoolRecord> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.session_id === 'string' &&
    typeof v.ts === 'string' &&
    typeof v.content === 'string' &&
    isNullableString(v.cwd) &&
    isNullableString(v.transcript_path) &&
    isNullableString(v.prompt_id) &&
    (v.flags === undefined || (Array.isArray(v.flags) && v.flags.every((f) => typeof f === 'string')))
  );
}

/**
 * A crash between claiming a file (rename to `.claimed`) and deleting it after a successful
 * ingest would otherwise strand that file forever -- nothing else ever looks at `.claimed` names.
 * Recover any `.claimed` file whose mtime is older than `STALE_CLAIM_MS`: rename it back to its
 * `.json` name so the normal drain loop below picks it up again. A rename that fails because
 * another process already recovered it first is ignored; `sourceRef` dedupe makes a re-ingest of
 * an already-applied record harmless either way.
 */
export const STALE_CLAIM_MS = 60_000;

function recoverStaleClaims(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json.claimed'));
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const full = path.join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue; // gone already
    }
    if (now - mtimeMs < STALE_CLAIM_MS) continue;
    try {
      fs.renameSync(full, full.slice(0, -'.claimed'.length));
    } catch {
      // another process already recovered it; ignore
    }
  }
}

export interface SpoolEraseTarget {
  /** The forgotten event's (already-redacted) content. */
  content: string;
  /** The forgotten event's source_ref; '' means "no source_ref to match on". */
  sourceRef: string;
}

/**
 * Phase 4 (`forget`, D31): physically deletes every spool file -- unclaimed (`.json`), claimed but not
 * yet drained (`.json.claimed`), or failed (`.json.bad`) -- that holds the forgotten event's content.
 * A file matches when its `content` equals the event's content, or (only when the event has a
 * source_ref) its `prompt_id` equals the event's source_ref: either alone is enough, since a prompt
 * spooled under the same hook invocation is the same logical event even if content diverges, and
 * identical content from a different invocation is still the same memory. `hooks.log` never matches --
 * it doesn't end in one of these three suffixes, and holds no memory content anyway (Phase 3 review).
 */
export function eraseMatchingSpoolFiles(target: SpoolEraseTarget): string[] {
  const dir = spoolDir();
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') || f.endsWith('.json.claimed') || f.endsWith('.json.bad'));
  } catch {
    return [];
  }

  const erased: string[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue; // unparseable (mid-write, or an already-corrupt .bad file) -- nothing to match on
    }
    const rec = raw as Partial<SpoolRecord> | null;
    if (!rec || typeof rec !== 'object') continue;
    const contentMatch = typeof rec.content === 'string' && rec.content === target.content;
    const refMatch =
      target.sourceRef !== '' && typeof rec.prompt_id === 'string' && rec.prompt_id === target.sourceRef;
    if (!contentMatch && !refMatch) continue;
    try {
      fs.unlinkSync(full);
      erased.push(name);
    } catch {
      // best effort; leaving a stray spool file behind is not worse than the pre-forget state
    }
  }
  return erased;
}

export interface DrainSpoolResult {
  /** Number of spool files successfully ingested and removed this call. */
  drained: number;
  /**
   * True if a write lock stopped the drain before it finished the backlog (fix round 1: Critical).
   * A caller that sees this should not attempt its own write either -- the same lock is almost
   * certainly still held, and trying would just pay a second full busy-wait for no benefit.
   */
  locked: boolean;
}

/**
 * Claims each `*.json` spool file by renaming it to `.claimed` first (atomic: a rename that fails
 * means another process already owns it, so it's skipped), then ingests it as a user event and
 * deletes it. A file that fails to parse or append is moved aside to `.bad`, not retried forever.
 *
 * Fix round 1 (Critical): stops at the FIRST lock error instead of `continue`-ing past it. Before
 * this fix, a backlog of N spooled files under a sustained lock made the hook pay N separate
 * `HOOK_BUSY_TIMEOUT_MS` busy-waits in one call -- an unbounded (N+1)x300ms worst case that blew the
 * HANDOFF §10 "<500ms, DB locked" acceptance target. One lock error strongly implies the lock is
 * still held for every other file too, so there is nothing to gain by retrying each one in turn: the
 * un-claimed file is put back (so the next drain retries it, same as before) and the rest of the
 * backlog is left untouched for that next drain. This bounds one `drainSpool` call to at most one
 * busy-wait, keeping the caller's own total at or under roughly `2 x HOOK_BUSY_TIMEOUT_MS` even if it
 * also attempts its own write afterward -- callers that receive `locked: true` should skip that
 * attempt entirely (see `DrainSpoolResult`) to stay under one busy-wait altogether.
 */
export function drainSpool(db: Db): DrainSpoolResult {
  const dir = spoolDir();
  recoverStaleClaims(dir);
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return { drained: 0, locked: false };
  }

  let drained = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    const claimed = `${full}.claimed`;
    try {
      fs.renameSync(full, claimed);
    } catch {
      continue; // another process already claimed (or removed) this file
    }

    const fileId = name.slice(0, -'.json'.length);
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(claimed, 'utf8'));
      if (!isSpoolRecord(raw)) throw new Error('malformed spool record');
      appendEvent(db, {
        sessionId: raw.session_id,
        role: 'user',
        content: raw.content,
        project: projectFromCwd(raw.cwd ?? undefined),
        sourceRef: raw.prompt_id ?? fileId,
        ts: raw.ts,
        // G6: content was already processed at spool-write time; use its flags as-is (explicit-flags
        // path) instead of re-running processContent, which would find nothing left to redact.
        preProcessedFlags: raw.flags ?? [],
      });
      fs.unlinkSync(claimed);
      drained++;
    } catch (err) {
      if (isLockError(err)) {
        try {
          fs.renameSync(claimed, full);
        } catch {
          // best effort; leave it claimed rather than throw out of a hook
        }
        // Fix round 1: stop here rather than continue -- see the doc comment above.
        return { drained, locked: true };
      }
      fs.renameSync(claimed, `${full}.bad`);
    }
  }
  return { drained, locked: false };
}
