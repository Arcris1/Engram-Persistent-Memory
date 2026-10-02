import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { dataDir } from '../config.js';

function pausedFlagPath(): string {
  return path.join(dataDir(), 'paused');
}

/**
 * §9.7 / Global Constraints: a flag file `<dataDir>/paused`, no schema change. Checked once in
 * `runHook` right after reading stdin and before any `openDb`/spool access, and once at the top of
 * every guarded MCP write tool. Never throws -- an unreadable dataDir just means "not paused".
 */
export function isPaused(): boolean {
  try {
    return fs.existsSync(pausedFlagPath());
  } catch {
    return false;
  }
}

/**
 * `engram pause` / `engram resume`. Only ever touches the flag file, never the database -- creating
 * `dataDir()` here (if missing) is safe because it is not `openDb`/spool access.
 */
export function setPaused(paused: boolean): void {
  const flag = pausedFlagPath();
  if (paused) {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(flag, '', { mode: 0o600 });
    return;
  }
  try {
    fs.unlinkSync(flag);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}

/** Exact text every guarded write tool returns while paused (Global Constraints). */
export const PAUSED_TEXT = 'engram is paused; nothing was written.';

/** Shared output-schema fragment every guarded write tool's outputSchema unions in. */
export const PausedOutputSchema = z.object({ paused: z.literal(true) });

/** The early-return result every guarded write tool returns, unevaluated, while paused. */
export function pausedToolResult(): {
  content: [{ type: 'text'; text: string }];
  structuredContent: { paused: true };
} {
  return { content: [{ type: 'text', text: PAUSED_TEXT }], structuredContent: { paused: true } };
}
