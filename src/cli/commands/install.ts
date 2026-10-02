import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { dataDir, dbPath, hooksLogPath } from '../../config.js';
import { upsertClaudeMdSnippet, removeClaudeMdSnippet, BEGIN_MARKER } from '../../install/claude-md.js';
import {
  CLAUDE_MEM_PLUGIN_KEY,
  HOOK_EVENTS,
  hasOwnedHook,
  hookCommand,
  mergeHooks,
  ownedHookCommand,
  removeHooks,
  type ClaudeMemRestore,
} from '../../install/settings.js';
import { getStats, type Stats } from '../../storage/stats.js';

export const ENGRAM_OWNED_MARKER = '<!-- engram-owned -->';

/** Re-exported under this name for callers that just want the raw command string (also used in tests). */
export const hookCommandFor = hookCommand;

/**
 * Walks up from this file (compiled to `dist/cli/commands/install.js`) to the directory containing
 * `package.json` with `"name": "engram-mem"`. Works the same from `src/` under vitest, since the
 * directory depth from repo root is identical in both layouts.
 */
export function resolveEngramRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'engram-mem') return dir;
      } catch {
        // not valid JSON (unlikely) -- keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('engram: could not resolve the engram install root (no package.json named "engram-mem" found above this file)');
}

export interface McpResult {
  status: number;
  stdout: string;
  stderr: string;
  /** True when `claude` could not answer at all (not installed, or it did not reply in time). */
  unavailable?: boolean;
}
export type McpRunner = (args: string[]) => McpResult;

/** Doctor's `claude mcp get` is only a check, so doctor alone passes this short leash explicitly. */
const MCP_GET_TIMEOUT_MS = 5000;
/** install/uninstall use this for every `claude mcp` call; a timeout there is an error, not "not registered". */
const MCP_TIMEOUT_MS = 30_000;
/** Most stdout/stderr text kept from one `claude` call. */
const MAX_OUTPUT = 1024 * 1024;

/**
 * Starting `claude` fires Claude Code's SessionStart hook -- engram's own `session-start` hook -- which
 * would add an empty session to the live database. ENGRAM_SKIP_HOOKS=<epoch ms> makes every hook exit 0 at once
 * until that moment: the call's timeout plus a 5 s margin. An expiry (not a flag) so a long-lived process that
 * `claude` happens to start cannot inherit it and silently stop capture for good.
 */
const mcpEnv = (timeoutMs: number): NodeJS.ProcessEnv => ({ ...process.env, ENGRAM_SKIP_HOOKS: String(Date.now() + timeoutMs + 5000) });

function failedMcpResult(err: unknown): McpResult {
  const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer; message?: string; code?: string; killed?: boolean; signal?: string | null };
  const unavailable = e.code === 'ENOENT' || e.code === 'ETIMEDOUT' || e.killed === true;
  return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') || e.message || String(err), ...(unavailable ? { unavailable: true } : {}) };
}

/**
 * Real `claude mcp ...` shell-out, behind this function so tests can inject a fake and assert argv.
 * A timeout and a missing `claude` come back as `unavailable`; stderr is captured, never inherited.
 */
export function defaultMcpRunner(args: string[], timeoutMs: number = MCP_TIMEOUT_MS): McpResult {
  try {
    const stdout = execFileSync('claude', args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: mcpEnv(timeoutMs) });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return failedMcpResult(err);
  }
}

/** The same call without blocking the event loop (the UI server uses it so a slow `claude` stalls nothing). */
export function defaultMcpRunnerAsync(args: string[], timeoutMs: number = MCP_TIMEOUT_MS): Promise<McpResult> {
  return new Promise((resolve) => {
    let out = '';
    let errOut = '';
    let done = false;
    const finish = (r: McpResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env: mcpEnv(timeoutMs) });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: 1, stdout: out, stderr: errOut || 'claude did not answer in time', unavailable: true });
    }, timeoutMs);
    // Listen for a spawn failure first: it can leave the streams undefined (EMFILE), and an unhandled 'error' would crash the server.
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish({ status: 1, stdout: out, stderr: errOut || err.message, ...(err.code === 'ENOENT' ? { unavailable: true } : {}) }),
    );
    // Cap what is kept: stop appending beyond 1 MiB per stream (the child still drains).
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errOut.length < MAX_OUTPUT) errOut += d.toString('utf8');
    });
    child.on('close', (code) => finish({ status: code ?? 1, stdout: out, stderr: code === 0 ? '' : errOut }));
  });
}

export interface McpOutcome {
  /** True iff a mutating call (`add`/`remove`) actually ran. */
  attempted: boolean;
  /** The mutating call's argv, when `attempted`. */
  args?: string[];
  status?: number;
  stdout?: string;
  stderr?: string;
  /** G3: set instead of attempting anything, when an 'engram' server already exists and isn't ours. */
  warning?: string;
  /** `claude` did not answer (not installed / timed out): an error outcome, nothing was changed. */
  unavailable?: boolean;
  /** G3: `get` found a registration that already matches execPath/root exactly; nothing ran. */
  noop?: boolean;
}

const MCP_SERVER_NAME = 'engram';
const MCP_GET_ARGS = ['mcp', 'get', MCP_SERVER_NAME];
const MCP_REMOVE_ARGS = ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME];

function mcpAddArgs(execPath: string, root: string): string[] {
  return ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', execPath, `${root}/dist/mcp.js`];
}

function unavailableOutcome(r: McpResult): McpOutcome {
  return { attempted: false, unavailable: true, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function isMcpNotFound(r: McpResult): boolean {
  return r.status !== 0 || /not found/i.test(r.stdout) || /not found/i.test(r.stderr);
}

function isMcpOwnedByEngram(r: McpResult): boolean {
  return r.stdout.includes('dist/mcp.js');
}

/**
 * Task0: the "already up to date" check must compare the registered command path for exact equality,
 * not substring containment (a registered path that merely CONTAINS `execPath` or `<root>/dist/mcp.js`
 * as a substring of something longer isn't actually the same path). Parses the `Command:`/`Args:` lines
 * `claude mcp get` prints; returns `undefined` if either line isn't found so the caller can tolerate
 * output-format drift by falling back to a repair (remove+add) instead of silently trusting a
 * substring match.
 */
export function parseMcpGetCommand(stdout: string): { command: string; args: string } | undefined {
  const commandMatch = /^\s*Command:\s*(.+)$/m.exec(stdout);
  const argsMatch = /^\s*Args:\s*(.+)$/m.exec(stdout);
  if (!commandMatch || !argsMatch) return undefined;
  return { command: commandMatch[1]!.trim(), args: argsMatch[1]!.trim() };
}

function isMcpUpToDate(stdout: string, execPath: string, root: string): boolean {
  const parsed = parseMcpGetCommand(stdout);
  return parsed !== undefined && parsed.command === execPath && parsed.args === `${root}/dist/mcp.js`;
}

/**
 * G3: `install` no longer blindly `add`s the MCP server -- it runs `claude mcp get engram` first
 * (through the injectable runner) and repairs a stale registration instead of leaving a duplicate or
 * silently doing nothing:
 * - not found (non-zero status, or "not found" in stdout/stderr) -> `add`.
 * - found and it's engram's own (`dist/mcp.js` in the output) but the registered execPath/root
 *   differ from the current ones (Task0: exact `Command:`/`Args:` equality, falling back to a repair
 *   when the output can't be parsed) -> `remove` then `add`.
 * - found and it's engram's own and already identical -> no-op (`noop: true`).
 * - found but not engram's (no `dist/mcp.js`) -> skipped with a warning; never removes someone
 *   else's `engram` server.
 */
function registerMcp(runner: McpRunner, execPath: string, root: string): McpOutcome {
  const getResult = runner(MCP_GET_ARGS);
  const addArgs = mcpAddArgs(execPath, root);

  if (getResult.unavailable) return unavailableOutcome(getResult);
  if (isMcpNotFound(getResult)) {
    const r = runner(addArgs);
    return { attempted: true, args: addArgs, ...r };
  }
  if (!isMcpOwnedByEngram(getResult)) {
    return {
      attempted: false,
      warning:
        "an MCP server named 'engram' already exists and isn't engram's own -- skipping MCP registration (never removing someone else's server)",
    };
  }
  if (isMcpUpToDate(getResult.stdout, execPath, root)) {
    return { attempted: false, noop: true, status: getResult.status, stdout: getResult.stdout, stderr: getResult.stderr };
  }
  runner(MCP_REMOVE_ARGS);
  const r = runner(addArgs);
  return { attempted: true, args: addArgs, ...r };
}

/**
 * Task0: `uninstall` runs `claude mcp get engram` first too, mirroring `registerMcp`'s ownership rule,
 * instead of unconditionally `remove`ing whatever is registered under that name:
 * - not found -> nothing to remove (`noop: true`), no `remove` call.
 * - found but not engram's own (no `dist/mcp.js`) -> skipped with a warning, never removed.
 * - found and it's engram's own (any execPath/root -- uninstall always removes its own registration
 *   regardless of whether it's stale) -> `remove`.
 */
function unregisterMcp(runner: McpRunner): McpOutcome {
  const getResult = runner(MCP_GET_ARGS);
  if (getResult.unavailable) return unavailableOutcome(getResult);
  if (isMcpNotFound(getResult)) {
    return { attempted: false, noop: true, status: getResult.status, stdout: getResult.stdout, stderr: getResult.stderr };
  }
  if (!isMcpOwnedByEngram(getResult)) {
    return {
      attempted: false,
      warning:
        "an MCP server named 'engram' already exists and isn't engram's own -- skipping removal (never removing someone else's server)",
    };
  }
  const r = runner(MCP_REMOVE_ARGS);
  return { attempted: true, args: MCP_REMOVE_ARGS, ...r };
}

export interface InstallOpts {
  claudeDir?: string;
  dryRun?: boolean;
  noMcp?: boolean;
  disableClaudeMem?: boolean;
  execPath?: string;
  root?: string;
  mcpRunner?: McpRunner;
}

export interface InstallResult {
  claudeDir: string;
  dryRun: boolean;
  settingsPath: string;
  settingsChanged: boolean;
  claudeMdPath: string;
  claudeMdChanged: boolean;
  consolidatePath: string;
  consolidateCopied: boolean;
  consolidateSkipped?: string;
  backups: string[];
  mcp: McpOutcome;
  /** Task0 (D30 guard): set whenever an owned hook entry already existed pointing at a different root
   * than the one this install is writing -- i.e. this install is repairing a stale/moved checkout. */
  rootChanged?: { from: string; to: string };
}

/**
 * Task0 (D30 guard): finds an already-owned hook entry (any event) whose recorded root differs from
 * the root this install is about to write, so `doInstall` can report the D30 "re-pointed" notice.
 * Returns the OLD root, or `undefined` when no owned entry existed yet, or the only owned entries
 * already point at the current root (a plain re-install / execPath-only change is not a root change).
 */
function detectRootChange(oldSettings: Record<string, unknown>, root: string): string | undefined {
  for (const [event, subcommand] of Object.entries(HOOK_EVENTS)) {
    const command = ownedHookCommand(oldSettings, root, event, subcommand);
    if (!command) continue;
    const parsed = parseHookCommand(command);
    if (parsed && parsed.root !== root) return parsed.root;
  }
  return undefined;
}

/**
 * G3 (doctor): extracts `{execPath, root}` out of an owned hook command string, matching both the
 * current marker format and the legacy pre-marker format (D28), so doctor can diagnose a stale path
 * either way.
 */
export function parseHookCommand(command: string): { execPath: string; root: string } | undefined {
  const markerMatch = /^ENGRAM_HOOK=1 "([^"]+)" "(.+)\/dist\/cli\.js" \S+ \|\| true$/.exec(command);
  if (markerMatch) return { execPath: markerMatch[1]!, root: markerMatch[2]! };
  const legacyMatch = /^"([^"]+)" "(.+)\/dist\/cli\.js" \S+$/.exec(command);
  if (legacyMatch) return { execPath: legacyMatch[1]!, root: legacyMatch[2]! };
  return undefined;
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** G3 (doctor): `node: ok|missing|differs from current (<path>)`. */
function diagnoseHookNode(execPath: string): { state: 'ok' | 'missing' | 'differs'; usable: boolean } {
  if (!fs.existsSync(execPath) || !isExecutableFile(execPath)) return { state: 'missing', usable: false };
  if (execPath !== process.execPath) return { state: 'differs', usable: true };
  return { state: 'ok', usable: true };
}

/**
 * G3 (doctor): `root: ok|missing dist/cli.js`, plus, when both node and `dist/cli.js` check out, an
 * optional `native module: ok|failed` check (`<node> -e "new
 * (require('<root>/node_modules/better-sqlite3'))(':memory:').close()"`, 3s timeout) -- local-only,
 * never `claude mcp`, so it needs no injectable runner.
 */
function diagnoseHookRoot(root: string): { state: 'ok' | 'missing'; usable: boolean } {
  const cliJs = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(cliJs)) return { state: 'missing', usable: false };
  return { state: 'ok', usable: true };
}

/**
 * Task0: a bare `require('better-sqlite3')` only loads `lib/index.js`, which constructs the `Database`
 * class but never touches the prebuilt `.node` addon -- better-sqlite3 13 resolves and `require()`s the
 * platform binary lazily, the first time a `Database` is actually opened (see `lib/binding.js`'s
 * `getBinding`). A `require()`-only check therefore reports "ok" even against a corrupted or
 * wrong-platform prebuild. Opening (and immediately closing) an in-memory database forces that lazy
 * load, so a broken binary surfaces here instead of on a session's first real hook invocation.
 */
function diagnoseNativeModule(execPath: string, root: string): 'ok' | 'failed' {
  const modulePath = path.join(root, 'node_modules', 'better-sqlite3');
  try {
    execFileSync(execPath, ['-e', `new (require(${JSON.stringify(modulePath)}))(':memory:').close()`], {
      timeout: 3000,
      stdio: 'ignore',
    });
    return 'ok';
  } catch {
    return 'failed';
  }
}

const HOOK_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** G5 (doctor): counts hooks.log lines containing 'Error' (covers 'SqliteError' too) whose leading
 * ISO timestamp falls within the last 24h; malformed/un-timestamped lines are skipped, not counted. */
export function countRecentHookErrors(logRaw: string, now: number = Date.now()): number {
  let count = 0;
  for (const line of logRaw.split('\n')) {
    if (!line) continue;
    const ts = line.slice(0, line.indexOf(' '));
    const t = Date.parse(ts);
    if (Number.isNaN(t) || now - t > HOOK_ERROR_WINDOW_MS) continue;
    if (line.includes('Error')) count++;
  }
  return count;
}

function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Finds the first `<base>`, `<base>-1`, `<base>-2`, ... that doesn't already exist on disk. */
export function uniqueBackupPath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  let n = 1;
  let candidate = `${basePath}-${n}`;
  while (fs.existsSync(candidate)) {
    n++;
    candidate = `${basePath}-${n}`;
  }
  return candidate;
}

/**
 * G6/Task0: mirrors the source file's permissions onto the backup (e.g. a hand-tightened settings.json
 * stays tightened in its backup copy too). The mode is read BEFORE writing and passed straight into
 * `writeFileSync`'s own `mode` option, so the backup is created with (umask-permitting) the right
 * permissions atomically rather than briefly existing world-readable at the process's default mode --
 * `chmodSync` afterward is belt-and-braces, guaranteeing the exact final mode regardless of umask.
 */
function backupFile(filePath: string, content: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = uniqueBackupPath(`${filePath}.engram-backup-${ts}`);
  let mode: number | undefined;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    mode = undefined; // source file gone -- fall back to the process default mode
  }
  fs.writeFileSync(backupPath, content, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) {
    try {
      fs.chmodSync(backupPath, mode);
    } catch {
      // unsupported on this platform -- ignore, the atomic write above already applied it (best effort)
    }
  }
  return backupPath;
}

interface JsonFormat {
  indent: string;
  trailingNewline: boolean;
}

/**
 * Detects the indentation and trailing-newline style of an existing settings.json so re-serializing
 * it doesn't reformat a file that used 4 spaces or tabs (Review item 1). Falls back to 2 spaces + a
 * trailing newline when the file doesn't exist yet, matching what a fresh install has always written.
 */
function detectJsonFormat(raw: string | undefined): JsonFormat {
  if (raw === undefined) return { indent: '  ', trailingNewline: true };
  const trailingNewline = raw.endsWith('\n');
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] === '\t') return { indent: '\t', trailingNewline };
    if (line[0] === ' ') {
      let count = 0;
      while (line[count] === ' ') count++;
      return { indent: ' '.repeat(count), trailingNewline };
    }
  }
  // No line started with whitespace (e.g. single-line JSON); still honor the trailing-newline style.
  return { indent: '  ', trailingNewline };
}

function serializeSettings(obj: Record<string, unknown>, format: JsonFormat): string {
  return `${JSON.stringify(obj, null, format.indent)}${format.trailingNewline ? '\n' : ''}`;
}

function paths(claudeDir: string) {
  return {
    settingsPath: path.join(claudeDir, 'settings.json'),
    claudeMdPath: path.join(claudeDir, 'CLAUDE.md'),
    consolidatePath: path.join(claudeDir, 'commands', 'consolidate.md'),
  };
}

/**
 * G6: install state (the claude-mem plugin's previous value, and whether `install` created
 * settings.json from nothing) lives in its own file instead of a key inside settings.json -- so a
 * person reading/editing settings.json by hand never sees engram's own bookkeeping mixed in, and
 * uninstall can tell a pre-existing `{}` apart from a file engram created.
 */
function installStatePath(claudeDir: string): string {
  return path.join(claudeDir, 'engram-install-state.json');
}

interface InstallState {
  /** Set only the first time `--disable-claude-mem` is applied; `null` means the key (or
   * `enabledPlugins` itself) didn't exist before. Absent entirely if disableClaudeMem was never used. */
  previousClaudeMem?: unknown;
  enabledPluginsCreated?: boolean;
  /** True if settings.json did not exist before the first install that wrote it. */
  settingsCreated?: boolean;
}

function readInstallState(claudeDir: string): InstallState {
  const raw = readFileIfExists(installStatePath(claudeDir));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InstallState;
  } catch {
    return {};
  }
}

function writeInstallState(claudeDir: string, state: InstallState): void {
  fs.writeFileSync(installStatePath(claudeDir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `engram install`: see Task 3 brief / global constraints (reversibility, backups, idempotence). */
export function doInstall(opts: InstallOpts = {}): InstallResult {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
  const root = opts.root ?? resolveEngramRoot();
  const execPath = opts.execPath ?? process.execPath;
  const dryRun = opts.dryRun ?? false;
  const backups: string[] = [];
  const { settingsPath, claudeMdPath, consolidatePath } = paths(claudeDir);

  const oldSettingsRaw = readFileIfExists(settingsPath);
  const oldSettings = oldSettingsRaw ? (JSON.parse(oldSettingsRaw) as Record<string, unknown>) : {};
  const oldRoot = detectRootChange(oldSettings, root);
  const newSettings = mergeHooks(oldSettings, root, { execPath, disableClaudeMem: opts.disableClaudeMem });
  const newSettingsText = serializeSettings(newSettings, detectJsonFormat(oldSettingsRaw));
  const settingsChanged = newSettingsText !== (oldSettingsRaw ?? '');
  const rootChanged = oldRoot !== undefined ? { from: oldRoot, to: root } : undefined;

  const oldClaudeMdRaw = readFileIfExists(claudeMdPath);
  const oldClaudeMd = oldClaudeMdRaw ?? '';
  const snippet = fs.readFileSync(path.join(root, 'docs', 'claude-md-snippet.md'), 'utf8');
  const newClaudeMd = upsertClaudeMdSnippet(oldClaudeMd, snippet);
  const claudeMdChanged = newClaudeMd !== oldClaudeMd;

  const oldConsolidate = readFileIfExists(consolidatePath);
  const consolidateSrc = fs.readFileSync(path.join(root, '.claude', 'commands', 'consolidate.md'), 'utf8');
  const newConsolidate = `${consolidateSrc.replace(/\n+$/, '')}\n${ENGRAM_OWNED_MARKER}\n`;
  const canWriteConsolidate = oldConsolidate === undefined || oldConsolidate.includes(ENGRAM_OWNED_MARKER);
  const consolidateChanged = canWriteConsolidate && newConsolidate !== (oldConsolidate ?? '');
  const consolidateSkipped = canWriteConsolidate ? undefined : 'a non-engram consolidate.md already exists';

  if (dryRun) {
    return {
      claudeDir,
      dryRun: true,
      settingsPath,
      settingsChanged,
      claudeMdPath,
      claudeMdChanged,
      consolidatePath,
      consolidateCopied: consolidateChanged,
      consolidateSkipped,
      backups: [],
      mcp: { attempted: false },
      rootChanged,
    };
  }

  fs.mkdirSync(claudeDir, { recursive: true });

  if (settingsChanged) {
    if (oldSettingsRaw !== undefined) backups.push(backupFile(settingsPath, oldSettingsRaw));
    fs.writeFileSync(settingsPath, newSettingsText);

    // G6: record (once) whether this install created settings.json, and (once, only when
    // disableClaudeMem is used) the claude-mem plugin's previous value -- never clobbered by a
    // later install, mirroring the old engram-key idempotency but now in its own state file.
    const state = readInstallState(claudeDir);
    if (state.settingsCreated === undefined) state.settingsCreated = oldSettingsRaw === undefined;
    if (opts.disableClaudeMem && !('previousClaudeMem' in state)) {
      const oldEnabledPlugins = oldSettings.enabledPlugins;
      const enabledPluginsExisted = isRecordLike(oldEnabledPlugins);
      state.previousClaudeMem =
        enabledPluginsExisted && CLAUDE_MEM_PLUGIN_KEY in oldEnabledPlugins ? oldEnabledPlugins[CLAUDE_MEM_PLUGIN_KEY] : null;
      state.enabledPluginsCreated = !enabledPluginsExisted;
    }
    writeInstallState(claudeDir, state);
  }
  if (claudeMdChanged) {
    if (oldClaudeMdRaw !== undefined) backups.push(backupFile(claudeMdPath, oldClaudeMdRaw));
    fs.writeFileSync(claudeMdPath, newClaudeMd);
  }
  if (canWriteConsolidate && consolidateChanged) {
    fs.mkdirSync(path.dirname(consolidatePath), { recursive: true });
    if (oldConsolidate !== undefined) backups.push(backupFile(consolidatePath, oldConsolidate));
    fs.writeFileSync(consolidatePath, newConsolidate);
  }

  let mcp: McpOutcome = { attempted: false };
  if (!opts.noMcp) {
    mcp = registerMcp(opts.mcpRunner ?? defaultMcpRunner, execPath, root);
  }

  return {
    claudeDir,
    dryRun: false,
    settingsPath,
    settingsChanged,
    claudeMdPath,
    claudeMdChanged,
    consolidatePath,
    consolidateCopied: canWriteConsolidate && consolidateChanged,
    consolidateSkipped,
    backups,
    mcp,
    rootChanged,
  };
}

export interface UninstallOpts {
  claudeDir?: string;
  dryRun?: boolean;
  noMcp?: boolean;
  root?: string;
  mcpRunner?: McpRunner;
}

export interface UninstallResult {
  claudeDir: string;
  dryRun: boolean;
  settingsChanged: boolean;
  claudeMdChanged: boolean;
  consolidateRemoved: boolean;
  backups: string[];
  mcp: McpOutcome;
}

/** `engram uninstall`: removes only what `doInstall` owns, restoring everything else byte-for-byte. */
export function doUninstall(opts: UninstallOpts = {}): UninstallResult {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
  const root = opts.root ?? resolveEngramRoot();
  const dryRun = opts.dryRun ?? false;
  const backups: string[] = [];
  const { settingsPath, claudeMdPath, consolidatePath } = paths(claudeDir);

  const oldSettingsRaw = readFileIfExists(settingsPath);
  const oldSettings = oldSettingsRaw ? (JSON.parse(oldSettingsRaw) as Record<string, unknown>) : {};
  const state = readInstallState(claudeDir);
  const claudeMemRestore: ClaudeMemRestore | undefined =
    'previousClaudeMem' in state
      ? { previousValue: state.previousClaudeMem, enabledPluginsCreated: state.enabledPluginsCreated === true }
      : undefined;
  const newSettings = removeHooks(oldSettings, root, claudeMemRestore);
  const hasSettingsContent = Object.keys(newSettings).length > 0;
  // G6: settings.json is deleted only when it's both now-empty AND engram created it from nothing;
  // a file that existed before install (even as a literal '{}') is always restored faithfully
  // instead. No recorded state (e.g. installed before this fix) falls back to the old behavior.
  const settingsCreatedByInstall = state.settingsCreated ?? true;
  const newSettingsText =
    hasSettingsContent || !settingsCreatedByInstall
      ? serializeSettings(newSettings, detectJsonFormat(oldSettingsRaw))
      : undefined;
  const settingsChanged = (newSettingsText ?? '') !== (oldSettingsRaw ?? '');

  const oldClaudeMdRaw = readFileIfExists(claudeMdPath);
  const oldClaudeMd = oldClaudeMdRaw ?? '';
  const newClaudeMd = removeClaudeMdSnippet(oldClaudeMd);
  const claudeMdChanged = newClaudeMd !== oldClaudeMd;

  const oldConsolidate = readFileIfExists(consolidatePath);
  const ownsConsolidate = oldConsolidate !== undefined && oldConsolidate.includes(ENGRAM_OWNED_MARKER);

  if (dryRun) {
    return { claudeDir, dryRun: true, settingsChanged, claudeMdChanged, consolidateRemoved: ownsConsolidate, backups: [], mcp: { attempted: false } };
  }

  if (settingsChanged && oldSettingsRaw !== undefined) {
    backups.push(backupFile(settingsPath, oldSettingsRaw));
    if (newSettingsText !== undefined) fs.writeFileSync(settingsPath, newSettingsText);
    else fs.rmSync(settingsPath);
  }
  if (claudeMdChanged && oldClaudeMdRaw !== undefined) {
    backups.push(backupFile(claudeMdPath, oldClaudeMdRaw));
    if (newClaudeMd.length > 0) fs.writeFileSync(claudeMdPath, newClaudeMd);
    else fs.rmSync(claudeMdPath);
  }
  if (ownsConsolidate) {
    backups.push(backupFile(consolidatePath, oldConsolidate!));
    fs.rmSync(consolidatePath);
  }
  // G6: clean up commands/ once it's genuinely empty -- note the consolidate.md backup just made
  // above (when ownsConsolidate) normally still lives there, so this is a no-op immediately after a
  // single uninstall; it mainly catches a dir left vacant by drift (e.g. a backup removed by hand).
  const commandsDir = path.join(claudeDir, 'commands');
  try {
    if (fs.readdirSync(commandsDir).length === 0) fs.rmdirSync(commandsDir);
  } catch {
    // not empty (something else -- or our own backup -- still lives there), or already gone
  }

  let mcp: McpOutcome = { attempted: false };
  if (!opts.noMcp) {
    mcp = unregisterMcp(opts.mcpRunner ?? defaultMcpRunner);
  }

  // G6: the install-state file is engram's own bookkeeping -- always cleared on uninstall, whether
  // or not it existed.
  try {
    fs.rmSync(installStatePath(claudeDir));
  } catch {
    // no state file to remove
  }

  return { claudeDir, dryRun: false, settingsChanged, claudeMdChanged, consolidateRemoved: ownsConsolidate, backups, mcp };
}

export interface DoctorOpts {
  claudeDir?: string;
  noMcp?: boolean;
  root?: string;
  mcpRunner?: McpRunner;
}

export interface DoctorHook {
  event: string;
  installed: boolean;
  node: 'ok' | 'missing' | 'differs' | null;
  root: 'ok' | 'missing' | null;
  nativeModule: 'ok' | 'failed' | null;
  /** Set when an installed hook's command could not be parsed (node/root/nativeModule are then null). */
  detail: string | null;
}

export interface DoctorReport {
  db: { path: string; exists: boolean; stats: Stats | null };
  hooks: DoctorHook[];
  mcp: { checked: boolean; registered: boolean; detail: string };
  claudeMd: { path: string; installed: boolean };
  /** `badFiles` (the `.bad` file names, sorted) is an addition to the plan's shape: the text report lists them. */
  spool: { backlog: number; bad: number; badFiles: string[] };
  hookErrors: { path: string; last24h: number; lastLines: string[] };
}

const UNPARSEABLE_HOOK = 'could not parse hook command';

/** What `claude mcp get engram` said, as the doctor's mcp section. */
function mcpStatus(r: McpResult): DoctorReport['mcp'] {
  if (r.unavailable) return { checked: false, registered: false, detail: 'could not check (claude did not answer in time, or is not installed)' };
  if (isMcpNotFound(r)) return { checked: true, registered: false, detail: 'not registered' };
  if (r.stdout.includes('dist/mcp.js')) {
    const summary = r.stdout.split('\n').find((l) => l.trim().length > 0);
    return { checked: true, registered: true, detail: summary ? summary.trim() : '' };
  }
  return { checked: true, registered: false, detail: "registered to something else (not engram's own)" };
}

/** `engram doctor` as data: read-only, tolerates a missing DB and never creates one. */
export function doctorReport(opts: DoctorOpts = {}): DoctorReport {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
  const root = opts.root ?? resolveEngramRoot();

  const dbFile = dbPath();
  const dbReport: DoctorReport['db'] = { path: dbFile, exists: fs.existsSync(dbFile), stats: null };
  if (dbReport.exists) {
    // G6: doctor is read-only end to end -- open directly, readonly, never via openDb (which would
    // chmod the file, set pragmas and possibly run a migration).
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      dbReport.stats = getStats(db, dbFile);
    } finally {
      db.close();
    }
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  const settingsRaw = readFileIfExists(settingsPath);
  const settings = settingsRaw ? (JSON.parse(settingsRaw) as Record<string, unknown>) : {};
  const hooks: DoctorHook[] = [];
  for (const [event, subcommand] of Object.entries(HOOK_EVENTS)) {
    const hook: DoctorHook = { event, installed: hasOwnedHook(settings, root, event, subcommand), node: null, root: null, nativeModule: null, detail: null };
    hooks.push(hook);
    if (!hook.installed) continue;
    const command = ownedHookCommand(settings, root, event, subcommand);
    const parsed = command ? parseHookCommand(command) : undefined;
    if (!parsed) {
      hook.detail = UNPARSEABLE_HOOK;
      continue;
    }
    const node = diagnoseHookNode(parsed.execPath);
    const root_ = diagnoseHookRoot(parsed.root);
    hook.node = node.state;
    hook.root = root_.state;
    if (node.usable && root_.usable) hook.nativeModule = diagnoseNativeModule(parsed.execPath, parsed.root);
  }

  const mcp: DoctorReport['mcp'] = opts.noMcp
    ? { checked: false, registered: false, detail: 'skipped (--no-mcp)' }
    : mcpStatus((opts.mcpRunner ?? ((a) => defaultMcpRunner(a, MCP_GET_TIMEOUT_MS)))(MCP_GET_ARGS));

  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMd = readFileIfExists(claudeMdPath) ?? '';

  const spoolPath = path.join(dataDir(), 'spool');
  let backlog = 0;
  let badFiles: string[] = [];
  try {
    const entries = fs.readdirSync(spoolPath);
    backlog = entries.filter((f) => f.endsWith('.json')).length;
    badFiles = entries.filter((f) => f.endsWith('.bad')).sort();
  } catch {
    backlog = 0;
  }

  const logRaw = readFileIfExists(hooksLogPath());
  const hookErrors: DoctorReport['hookErrors'] = { path: hooksLogPath(), last24h: 0, lastLines: [] };
  if (logRaw) {
    hookErrors.last24h = countRecentHookErrors(logRaw);
    hookErrors.lastLines = logRaw.split('\n').filter((l) => l.length > 0).slice(-5);
  }

  return {
    db: dbReport,
    hooks,
    mcp,
    claudeMd: { path: claudeMdPath, installed: claudeMd.includes(BEGIN_MARKER) },
    spool: { backlog, bad: badFiles.length, badFiles },
    hookErrors,
  };
}

/** `doctorReport` with the `claude mcp get` call run asynchronously (a fake `mcpRunner` or `noMcp` keeps the sync path). */
export async function doctorReportAsync(opts: DoctorOpts = {}, mcpTimeoutMs: number = MCP_GET_TIMEOUT_MS): Promise<DoctorReport> {
  if (opts.noMcp || opts.mcpRunner) return doctorReport(opts);
  const report = doctorReport({ ...opts, noMcp: true });
  report.mcp = mcpStatus(await defaultMcpRunnerAsync(MCP_GET_ARGS, mcpTimeoutMs));
  return report;
}

/** `engram doctor`: the text form of `doctorReport`. */
export function doDoctor(opts: DoctorOpts = {}): string {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
  return formatDoctorReport(doctorReport(opts), claudeDir);
}

/** The `engram doctor` text for a report (`claudeDir` only names the settings.json in the hooks header). */
export function formatDoctorReport(report: DoctorReport, claudeDir: string): string {
  const lines: string[] = ['engram doctor'];

  lines.push(`  db: ${report.db.path}`);
  const stats = report.db.stats;
  if (!stats) {
    lines.push('    no database yet');
  } else {
    lines.push(`    schema v${stats.schema_version}, ${stats.db_bytes} bytes`);
    lines.push(`    events: ${stats.events}, sessions: ${stats.sessions} (${stats.unconsolidated_sessions} unconsolidated)`);
    lines.push(`    claims: ${stats.claims.active} active, ${stats.claims.superseded} superseded, ${stats.claims.retracted} retracted`);
  }

  lines.push(`  hooks (${path.join(claudeDir, 'settings.json')}):`);
  for (const h of report.hooks) {
    lines.push(`    ${h.event.padEnd(16)} ${h.installed ? 'installed' : 'missing'}`);
    if (!h.installed) continue;
    if (h.detail) {
      lines.push(`      (${h.detail})`);
      continue;
    }
    lines.push(`      ${h.node === 'differs' ? `node: differs from current (${process.execPath})` : `node: ${h.node}`}`);
    lines.push(`      ${h.root === 'missing' ? 'root: missing dist/cli.js' : 'root: ok'}`);
    if (h.nativeModule) lines.push(`      native module: ${h.nativeModule}`);
  }

  lines.push('  mcp:');
  if (report.mcp.registered) {
    lines.push('    registered');
    if (report.mcp.detail) lines.push(`    ${report.mcp.detail}`);
  } else {
    lines.push(`    ${report.mcp.detail}`);
  }

  lines.push(`  CLAUDE.md snippet (${report.claudeMd.path}): ${report.claudeMd.installed ? 'installed' : 'missing'}`);

  lines.push(`  spool backlog: ${report.spool.backlog}`);
  // G5: spool files moved aside as unrecoverable (see drainSpool) are otherwise invisible -- surface them.
  lines.push(`  spool .bad files: ${report.spool.bad}`);
  for (const f of report.spool.badFiles) lines.push(`    ${f}`);

  lines.push(`  hooks.log (${report.hookErrors.path}):`);
  if (report.hookErrors.lastLines.length === 0) {
    lines.push('    (empty)');
  } else {
    lines.push(`    ${report.hookErrors.last24h} error line(s) in the last 24h`);
    for (const l of report.hookErrors.lastLines) lines.push(`    ${l}`);
  }

  return `${lines.join('\n')}\n`;
}

function parseFlags(args: string[]): { claudeDir?: string; dryRun: boolean; noMcp: boolean; disableClaudeMem: boolean } {
  let claudeDir: string | undefined;
  let dryRun = false;
  let noMcp = false;
  let disableClaudeMem = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--claude-dir') claudeDir = args[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--no-mcp') noMcp = true;
    else if (a === '--disable-claude-mem') disableClaudeMem = true;
  }
  return { claudeDir, dryRun, noMcp, disableClaudeMem };
}

function formatMcp(mcp: McpOutcome, dryRun: boolean): string {
  if (mcp.unavailable) return `error: claude did not answer (not installed or timed out): ${mcp.stderr ?? ''}`.trimEnd();
  if (mcp.warning) return `skipped: ${mcp.warning}`;
  if (mcp.noop) return 'ok (nothing to do)';
  if (!mcp.attempted) return dryRun ? '(not attempted: dry run)' : '(skipped: --no-mcp)';
  return mcp.status === 0 ? 'ok' : `error (exit ${mcp.status}): ${mcp.stderr}`;
}

export function installCommand(args: string[]): number {
  const flags = parseFlags(args);
  try {
    const r = doInstall(flags);
    process.stdout.write(
      [
        `engram install${r.dryRun ? ' (dry run)' : ''} -- ${r.claudeDir}`,
        ...(r.rootChanged ? [`engram: hooks re-pointed from ${r.rootChanged.from} to ${r.rootChanged.to}`] : []),
        `  settings.json: ${r.settingsChanged ? 'updated' : 'unchanged'}`,
        `  CLAUDE.md:     ${r.claudeMdChanged ? 'updated' : 'unchanged'}`,
        `  consolidate:   ${r.consolidateCopied ? 'copied' : r.consolidateSkipped ? `skipped (${r.consolidateSkipped})` : 'unchanged'}`,
        `  mcp:           ${formatMcp(r.mcp, r.dryRun)}`,
        ...r.backups.map((b) => `  backup:        ${b}`),
        '',
      ].join('\n'),
    );
    return r.mcp.unavailable ? 1 : 0;
  } catch (err) {
    process.stderr.write(`engram install: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function uninstallCommand(args: string[]): number {
  const flags = parseFlags(args);
  try {
    const r = doUninstall(flags);
    process.stdout.write(
      [
        `engram uninstall${r.dryRun ? ' (dry run)' : ''} -- ${r.claudeDir}`,
        `  settings.json: ${r.settingsChanged ? 'restored' : 'unchanged'}`,
        `  CLAUDE.md:     ${r.claudeMdChanged ? 'restored' : 'unchanged'}`,
        `  consolidate:   ${r.consolidateRemoved ? 'removed' : 'unchanged'}`,
        `  mcp:           ${formatMcp(r.mcp, r.dryRun)}`,
        ...r.backups.map((b) => `  backup:        ${b}`),
        '',
      ].join('\n'),
    );
    return r.mcp.unavailable ? 1 : 0;
  } catch (err) {
    process.stderr.write(`engram uninstall: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function doctorCommand(args: string[]): number {
  const flags = parseFlags(args);
  try {
    process.stdout.write(doDoctor(flags));
    return 0;
  } catch (err) {
    process.stderr.write(`engram doctor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
