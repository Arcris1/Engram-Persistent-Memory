/**
 * Pure JSON-merge logic for `~/.claude/settings.json` (Task 3 / installer reversibility, Review
 * Focus #3). Every function here takes and returns a plain settings object -- no filesystem I/O --
 * so it can be unit-tested without touching any real or temp file.
 */

export const HOOK_EVENTS: Record<string, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'ingest-prompt',
  Stop: 'ingest-transcript',
  PreCompact: 'ingest-transcript',
  SessionEnd: 'session-end',
};

export const CLAUDE_MEM_PLUGIN_KEY = 'claude-mem@thedotmack';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** G3: every hook command engram writes carries this marker, so ownership can be detected even
 * after the recorded node execPath AND the install root have both changed (a stale/moved install). */
export const ENGRAM_HOOK_ENV_MARKER = 'ENGRAM_HOOK=1 ';

/**
 * `ENGRAM_HOOK=1 "<execPath>" "<root>/dist/cli.js" <subcommand> || true` -- both paths quoted (D11
 * non-interactive PATH), so a space in either path survives as a single shell argument. A `"` in
 * either path would break out of that quoting, so it's rejected outright rather than silently
 * producing a broken command. `|| true` makes a missing/broken node binary exit 0 (127 -> 0) instead
 * of surfacing as a hook failure; session-start's stdout is unaffected since it's written by `node`
 * itself before `sh` ever sees the exit code.
 */
export function hookCommand(execPath: string, root: string, subcommand: string): string {
  if (execPath.includes('"') || root.includes('"')) {
    throw new Error('engram: execPath and root must not contain a double-quote character');
  }
  return `${ENGRAM_HOOK_ENV_MARKER}"${execPath}" "${root}/dist/cli.js" ${subcommand} || true`;
}

/**
 * G3 (tightened by Task0): an owned command is detected by EITHER (a) the new marker format -- the
 * command STARTS WITH `ENGRAM_HOOK=1 "` (not merely contains it -- a foreign hook command that happens
 * to embed the marker as a substring, e.g. `XENGRAM_HOOK=1 "..."` or one that quotes it inside another
 * value, must never be mistaken for engram's own) and ends with ` <subcommand> || true`, independent of
 * execPath or root, so a repair (changed node path or moved root) still finds and replaces the old
 * entry -- OR (b) the old pre-marker substring `<root>/dist/cli.js <subcommand>` (quotes stripped),
 * kept for harmless backward compatibility; no real installs exist yet to actually be running the old
 * format.
 */
function isOwnedCommand(command: string, root: string, subcommand: string): boolean {
  if (command.startsWith(`${ENGRAM_HOOK_ENV_MARKER}"`) && command.endsWith(` ${subcommand} || true`)) return true;
  const legacyNeedle = `${root}/dist/cli.js ${subcommand}`;
  return command.replace(/"/g, '').includes(legacyNeedle);
}

function groupHasOwnedCommand(group: unknown, root: string, subcommand: string): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return (group.hooks as unknown[]).some(
    (h) => isRecord(h) && typeof h.command === 'string' && isOwnedCommand(h.command, root, subcommand),
  );
}

function hookGroupsFor(settings: Record<string, unknown>, event: string): unknown[] {
  if (!isRecord(settings.hooks)) return [];
  const arr = settings.hooks[event];
  return Array.isArray(arr) ? arr : [];
}

/** True when `settings` already has an engram-owned entry for this event/subcommand. */
export function hasOwnedHook(settings: Record<string, unknown>, root: string, event: string, subcommand: string): boolean {
  return hookGroupsFor(settings, event).some((g) => groupHasOwnedCommand(g, root, subcommand));
}

/** G3 (doctor): the raw command string of engram's owned hook entry for this event, if any. */
export function ownedHookCommand(
  settings: Record<string, unknown>,
  root: string,
  event: string,
  subcommand: string,
): string | undefined {
  for (const group of hookGroupsFor(settings, event)) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks as unknown[]) {
      if (isRecord(h) && typeof h.command === 'string' && isOwnedCommand(h.command, root, subcommand)) return h.command;
    }
  }
  return undefined;
}

export interface MergeHooksOptions {
  execPath: string;
  /** D28: sets enabledPlugins['claude-mem@thedotmack'] = false. The previous value is captured by
   * the caller (installer), not recorded here -- see G6 / `ClaudeMemRestore`. */
  disableClaudeMem?: boolean;
}

/**
 * Adds, per event in HOOK_EVENTS, one hook group `{ hooks: [{ type:'command', command, timeout: 5 }] }`
 * -- idempotent (an event whose owned entry already has the freshly generated command is left
 * byte-identical) and preserves every other key and every other hook event/group untouched.
 *
 * G3 repair: when an event already has one or more owned entries but none matches the freshly
 * generated command exactly (a stale execPath after a node upgrade, a moved install root, or
 * duplicate owned entries left behind by an install from a second root), every owned entry for that
 * event is replaced by exactly one fresh one -- `isOwnedCommand`'s marker-based detection finds a
 * stale entry regardless of what execPath/root it was written with.
 *
 * With `disableClaudeMem`, also flips the claude-mem plugin off. G6: unlike before, this function no
 * longer records the plugin's previous value anywhere in `settings` itself (no more `engram` key) --
 * that bookkeeping moved to `<claude-dir>/engram-install-state.json`, owned by the installer
 * (`src/cli/commands/install.ts`), since this function must stay a pure settings-merge with no notion
 * of "what was captured on a previous call". Pass the captured previous value back in via
 * `removeHooks`'s `claudeMemRestore` parameter to undo this flip.
 */
export function mergeHooks(
  settings: Record<string, unknown>,
  root: string,
  opts: MergeHooksOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...settings };
  const hooksObj: Record<string, unknown> = isRecord(result.hooks) ? { ...result.hooks } : {};

  for (const [event, subcommand] of Object.entries(HOOK_EVENTS)) {
    const existing = Array.isArray(hooksObj[event]) ? (hooksObj[event] as unknown[]) : [];
    const ownedGroups = existing.filter((g) => groupHasOwnedCommand(g, root, subcommand));
    const freshGroup = { hooks: [{ type: 'command', command: hookCommand(opts.execPath, root, subcommand), timeout: 5 }] };
    if (ownedGroups.length === 1 && JSON.stringify(ownedGroups[0]) === JSON.stringify(freshGroup)) {
      hooksObj[event] = existing; // already exactly right -- byte-identical, no repair needed
      continue;
    }
    const unowned = existing.filter((g) => !groupHasOwnedCommand(g, root, subcommand));
    hooksObj[event] = [...unowned, freshGroup];
  }
  result.hooks = hooksObj;

  if (opts.disableClaudeMem) {
    const enabledPlugins: Record<string, unknown> = isRecord(result.enabledPlugins)
      ? { ...(result.enabledPlugins as Record<string, unknown>) }
      : {};
    enabledPlugins[CLAUDE_MEM_PLUGIN_KEY] = false;
    result.enabledPlugins = enabledPlugins;
  }

  return result;
}

/** G6: what to restore the claude-mem plugin flag to, captured by the installer at the time
 * `disableClaudeMem` was first applied (from `engram-install-state.json`, not from `settings`). */
export interface ClaudeMemRestore {
  /** The value `enabledPlugins['claude-mem@thedotmack']` held before install, or `null` if the key
   * (or `enabledPlugins` itself) didn't exist yet. */
  previousValue: unknown;
  /** True if `enabledPlugins` itself didn't exist before install (so it should be removed entirely
   * if restoring leaves it empty). */
  enabledPluginsCreated: boolean;
}

/**
 * Deletes only the hook entries (and the arrays/objects left empty by deleting them) that
 * `mergeHooks` added. Everything else in `settings` is returned byte-for-byte equal to how it came
 * in. With `claudeMemRestore` (sourced from the installer's `engram-install-state.json`), also
 * restores the claude-mem plugin flag `mergeHooks` toggled.
 */
export function removeHooks(
  settings: Record<string, unknown>,
  root: string,
  claudeMemRestore?: ClaudeMemRestore,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...settings };

  if (isRecord(result.hooks)) {
    const hooksObj: Record<string, unknown> = { ...result.hooks };
    for (const [event, subcommand] of Object.entries(HOOK_EVENTS)) {
      if (!Array.isArray(hooksObj[event])) continue;
      const filtered = (hooksObj[event] as unknown[]).filter((g) => !groupHasOwnedCommand(g, root, subcommand));
      if (filtered.length > 0) hooksObj[event] = filtered;
      else delete hooksObj[event];
    }
    if (Object.keys(hooksObj).length > 0) result.hooks = hooksObj;
    else delete result.hooks;
  }

  if (claudeMemRestore) {
    const enabledPlugins: Record<string, unknown> = isRecord(result.enabledPlugins)
      ? { ...(result.enabledPlugins as Record<string, unknown>) }
      : {};
    if (claudeMemRestore.previousValue === null) delete enabledPlugins[CLAUDE_MEM_PLUGIN_KEY];
    else enabledPlugins[CLAUDE_MEM_PLUGIN_KEY] = claudeMemRestore.previousValue;

    if (claudeMemRestore.enabledPluginsCreated && Object.keys(enabledPlugins).length === 0) delete result.enabledPlugins;
    else result.enabledPlugins = enabledPlugins;
  }

  return result;
}
