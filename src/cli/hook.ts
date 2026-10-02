import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { hooksLogPath } from '../config.js';
import { isPaused } from '../control/pause.js';
import { redactSecrets } from '../core/redact.js';
import { isLockError } from './spool.js';

/** Hooks must finish fast (§8.3); don't wait long for a competing writer. G6: tightened from 300ms. */
export const HOOK_BUSY_TIMEOUT_MS = 200;

export const HookInputSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  hook_event_name: z.string().optional(),
  prompt: z.string().optional(),
  user_input: z.string().optional(), // D11: unresolved field name; accept both
  prompt_id: z.string().optional(),
  // D25 (verified against Claude Code 2.1.286): SessionStart's `source` (startup|resume|clear|compact)
  // and SessionEnd's `reason`. Kept loose (string) since the hook must never reject on an unknown value.
  source: z.string().optional(),
  reason: z.string().optional(),
});
export type HookInput = z.infer<typeof HookInputSchema>;

/** Hooks must finish fast; read stdin with a short timeout and a hard size cap (never buffer unboundedly). */
export function readStdin(timeoutMs = 400, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.destroy();
      reject(err);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(new Error('stdin exceeds 4 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** G5: hooks.log is capped so an unattended, erroring hook can never fill the disk. */
export const HOOKS_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Shared safe-append path: mkdir the log's directory, rotate if the file has grown past
 * HOOKS_LOG_MAX_BYTES (renamed to `hooks.log.1`, replacing any previous one), append one line, mode
 * 0600. Never throws.
 */
export function appendHooksLog(line: string): void {
  try {
    const file = hooksLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > HOOKS_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // file doesn't exist yet -- nothing to rotate
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // A broken memory hook must never break a coding session (§8.3), not even through logging.
  }
}

/**
 * True for Node's ENOENT (`err.code === 'ENOENT'`) -- e.g. a hook's transcript_path pointing at a
 * file that hasn't been written yet. A decision from the live go-live: this is a legitimate,
 * silent no-op for a session with no messages, not an error worth a hooks.log line.
 */
export function isEnoentError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 'ENOENT';
}

/**
 * G1/G6: a lock error (isLockError) is routine contention, not a bug -- log it as a single short line
 * instead of a full stack trace, which would otherwise dominate hooks.log under any sustained lock.
 * Every other error keeps the redacted stack-or-message behavior.
 */
export function logHookError(command: string, err: unknown): void {
  if (isLockError(err)) {
    appendHooksLog(`${new Date().toISOString()} [${command}] database locked; deferred\n`);
    return;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  appendHooksLog(`${new Date().toISOString()} [${command}] ${redactSecrets(message).text}\n`);
}

/**
 * D(timing): when `ENGRAM_HOOK_TIMING=1`, `runHook` logs the hook's own in-process elapsed time
 * (node startup excluded -- the clock starts inside `runHook`, after the process is already up) as
 * `hook-timing <command> <ms>ms`, for the Phase 3 "< 500ms" acceptance check to measure against.
 */
export function logHookTiming(command: string, ms: number): void {
  appendHooksLog(`hook-timing ${command} ${ms.toFixed(2)}ms\n`);
}

/**
 * Run a hook handler. Always resolves to exit code 0.
 * By default (and for every hook except `session-start`) nothing is ever written to stdout. When
 * `allowStdout` is true, the handler's returned string is written once, after it has fully
 * resolved without throwing -- never partial output, and nothing at all on any error.
 *
 * Pause (Global Constraints): `isPaused()` is checked once here, right after reading stdin and
 * before any `openDb`/spool access -- `handler` is never called while paused, so there is no DB
 * open, no spool write or drain, and no stdout.
 */
export async function runHook(
  command: string,
  handler: (input: HookInput) => string | void | Promise<string | void>,
  opts: { allowStdout?: boolean } = {},
): Promise<number> {
  // ENGRAM_SKIP_HOOKS=<epoch ms>: set by engram's own `claude mcp ...` shell-outs (install/doctor/UI Health) to
  // the moment the call's timeout + 5 s margin ends. Starting `claude` fires the SessionStart hook, which would
  // write an empty session into the real database. While that moment is in the future, exit before reading stdin,
  // opening the DB, spooling or printing anything. Anything else (unset, `1`, `true`, a past time, garbage) runs
  // the hook, so a long-lived process that inherited the variable cannot silently stop capture.
  const skipUntil = Number(process.env.ENGRAM_SKIP_HOOKS);
  if (process.env.ENGRAM_SKIP_HOOKS !== '' && Number.isFinite(skipUntil) && skipUntil > Date.now()) return 0;
  const timingEnabled = process.env.ENGRAM_HOOK_TIMING === '1';
  const startedAt = timingEnabled ? process.hrtime.bigint() : undefined;
  try {
    const raw = await readStdin();
    if (isPaused()) return 0;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // V8's JSON error message quotes a slice of the input, which could be part of a secret: log size only.
      throw new Error(`stdin is not valid JSON (${raw.length} bytes)`);
    }
    const result = await handler(HookInputSchema.parse(json));
    if (opts.allowStdout && typeof result === 'string' && result.length > 0) {
      process.stdout.write(result);
    }
  } catch (err) {
    logHookError(command, err);
  }
  if (startedAt !== undefined) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logHookTiming(command, ms);
  }
  return 0;
}
