import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENGRAM_OWNED_MARKER,
  doDoctor,
  doInstall,
  doUninstall,
  hookCommandFor,
  installCommand,
  resolveEngramRoot,
  uniqueBackupPath,
} from '../src/cli/commands/install.js';
import { MALFORMED_MARKERS_MESSAGE, BEGIN_MARKER, END_MARKER, upsertClaudeMdSnippet } from '../src/install/claude-md.js';
import { HOOK_EVENTS, hasOwnedHook, hookCommand, mergeHooks, removeHooks } from '../src/install/settings.js';
import { ROOT, runCli, tmpDbFile, tmpDir } from './helpers.js';

const EXEC_PATH = '/usr/bin/node-fake';

/**
 * A minimal second "engram root" for tests that need `doInstall`/`doDoctor` to treat a *different*
 * root as the install source (root-change notice, native-module check against a corrupted copy):
 * copies just the two files `doInstall` reads off the real root (`docs/claude-md-snippet.md`,
 * `.claude/commands/consolidate.md`) so it's a valid install source without being a full checkout.
 */
function makeFakeEngramRoot(): string {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'docs', 'claude-md-snippet.md'), path.join(root, 'docs', 'claude-md-snippet.md'));
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, '.claude', 'commands', 'consolidate.md'),
    path.join(root, '.claude', 'commands', 'consolidate.md'),
  );
  return root;
}

let prevDb: string | undefined;
function useDb(dbFile: string): void {
  prevDb = process.env.ENGRAM_DB;
  process.env.ENGRAM_DB = dbFile;
}
afterEach(() => {
  if (prevDb === undefined) delete process.env.ENGRAM_DB;
  else process.env.ENGRAM_DB = prevDb;
  prevDb = undefined;
});

describe('resolveEngramRoot', () => {
  it('resolves to the repo root (package.json name engram-mem)', () => {
    expect(resolveEngramRoot()).toBe(ROOT);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('engram-mem');
  });
});

describe('settings.ts mergeHooks / removeHooks (pure)', () => {
  const root = '/opt/engram';

  it('adds one hook group per event and is idempotent', () => {
    const once = mergeHooks({}, root, { execPath: EXEC_PATH });
    const hooks = once.hooks as Record<string, Array<{ hooks: Array<{ command: string; type: string; timeout: number }> }>>;
    expect(Object.keys(hooks).sort()).toEqual(
      ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
    expect(hooks.SessionStart![0]!.hooks[0]).toEqual({
      type: 'command',
      command: `ENGRAM_HOOK=1 "${EXEC_PATH}" "${root}/dist/cli.js" session-start || true`,
      timeout: 5,
    });
    expect(hooks.Stop![0]!.hooks[0]!.command).toContain('ingest-transcript');
    expect(hooks.PreCompact![0]!.hooks[0]!.command).toContain('ingest-transcript');

    const twice = mergeHooks(once, root, { execPath: EXEC_PATH });
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('preserves unrelated hook events and other top-level keys', () => {
    const input = {
      enabledPlugins: { 'claude-mem@thedotmack': true, 'other@x': true },
      hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      someOtherKey: 'value',
    };
    const merged = mergeHooks(input, root, { execPath: EXEC_PATH });
    expect((merged.hooks as Record<string, unknown>).Notification).toEqual(input.hooks.Notification);
    expect(merged.enabledPlugins).toEqual(input.enabledPlugins);
    expect(merged.someOtherKey).toBe('value');
  });

  it('detects engram-owned entries even if the node path changes', () => {
    const settings = mergeHooks({}, root, { execPath: '/old/node' });
    expect(hasOwnedHook(settings, root, 'SessionStart', 'session-start')).toBe(true);
    // simulate the node path changing later -- detection keys off dist/cli.js <subcommand>, not execPath
    const movedNode = mergeHooks({}, root, { execPath: '/new/node/bin' });
    expect(hasOwnedHook(movedNode, root, 'SessionStart', 'session-start')).toBe(true);
  });

  it('Task0: a command merely containing the marker (not starting with it) is never treated as owned', () => {
    // Deliberately a DIFFERENT embedded root from `root` so the legacy substring fallback can't match
    // either -- this isolates the marker check itself (startsWith, not includes) from the legacy rule.
    const foreign = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'XENGRAM_HOOK=1 "/usr/bin/node" "/totally/different/root/dist/cli.js" session-start || true',
              },
            ],
          },
        ],
      },
    };
    expect(hasOwnedHook(foreign, root, 'SessionStart', 'session-start')).toBe(false);

    // mergeHooks must add its own fresh entry alongside the foreign one, not treat it as already correct.
    const merged = mergeHooks(foreign, root, { execPath: EXEC_PATH });
    const groups = (merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).SessionStart!;
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.hooks[0]!.command.startsWith('XENGRAM_HOOK=1'))).toBe(true);
    expect(groups.some((g) => g.hooks[0]!.command.startsWith('ENGRAM_HOOK=1 "'))).toBe(true);

    // removeHooks must leave the foreign, unowned entry alone.
    const removed = removeHooks(merged, root);
    const remaining = (removed.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).SessionStart!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.hooks[0]!.command).toContain('XENGRAM_HOOK=1');
  });

  it('removeHooks deletes only engram-owned entries, restoring an empty hooks key to absent', () => {
    const merged = mergeHooks({}, root, { execPath: EXEC_PATH });
    const removed = removeHooks(merged, root);
    expect(removed).toEqual({});
  });

  it('removeHooks preserves unrelated hook groups and drops only engram ones', () => {
    const input = { hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    const merged = mergeHooks(input, root, { execPath: EXEC_PATH });
    const removed = removeHooks(merged, root);
    expect(removed).toEqual(input);
  });

  it('G6: disableClaudeMem toggles the plugin flag but records nothing in settings itself', () => {
    const input = { enabledPlugins: { 'claude-mem@thedotmack': true } };
    const merged = mergeHooks(input, root, { execPath: EXEC_PATH, disableClaudeMem: true });
    expect((merged.enabledPlugins as Record<string, unknown>)['claude-mem@thedotmack']).toBe(false);
    expect(merged.engram).toBeUndefined();
  });

  it('G6: removeHooks with a claudeMemRestore restores the previous value (captured externally, by the installer)', () => {
    const input = { enabledPlugins: { 'claude-mem@thedotmack': true } };
    const merged = mergeHooks(input, root, { execPath: EXEC_PATH, disableClaudeMem: true });
    const restored = removeHooks(merged, root, { previousValue: true, enabledPluginsCreated: false });
    expect(restored).toEqual(input);
  });

  it('G6: removeHooks with claudeMemRestore.previousValue null and enabledPluginsCreated restores to no key at all', () => {
    const merged = mergeHooks({}, root, { execPath: EXEC_PATH, disableClaudeMem: true });
    expect((merged.enabledPlugins as Record<string, unknown>)['claude-mem@thedotmack']).toBe(false);
    const restored = removeHooks(merged, root, { previousValue: null, enabledPluginsCreated: true });
    expect(restored).toEqual({});
  });

  it('G6: removeHooks without a claudeMemRestore leaves the plugin flag untouched', () => {
    const input = { enabledPlugins: { 'claude-mem@thedotmack': true } };
    const merged = mergeHooks(input, root, { execPath: EXEC_PATH, disableClaudeMem: true });
    expect(removeHooks(merged, root)).toEqual({ enabledPlugins: { 'claude-mem@thedotmack': false } });
  });
});

describe('claude-md.ts upsertClaudeMdSnippet (pure)', () => {
  it('appends markers to existing content and removal is byte-identical to the original', async () => {
    const { removeClaudeMdSnippet } = await import('../src/install/claude-md.js');
    const original = '# My CLAUDE.md\nSome notes.\n';
    const withSnippet = upsertClaudeMdSnippet(original, '## Memory (engram)\n- line one\n');
    expect(withSnippet).toContain(BEGIN_MARKER);
    expect(withSnippet).toContain(END_MARKER);
    expect(withSnippet.startsWith(original)).toBe(true);
    expect(removeClaudeMdSnippet(withSnippet)).toBe(original);
  });

  it('replaces an existing block in place without disturbing surrounding content', async () => {
    const { removeClaudeMdSnippet } = await import('../src/install/claude-md.js');
    const original = '# Notes\n';
    const v1 = upsertClaudeMdSnippet(original, '## Memory (engram)\n- old text\n');
    const v2 = upsertClaudeMdSnippet(v1, '## Memory (engram)\n- new text\n');
    expect(v2).toContain('new text');
    expect(v2).not.toContain('old text');
    expect(removeClaudeMdSnippet(v2)).toBe(original);
  });

  it('creating from nothing and removing returns empty string', async () => {
    const { removeClaudeMdSnippet } = await import('../src/install/claude-md.js');
    const withSnippet = upsertClaudeMdSnippet('', '## Memory (engram)\n- x\n');
    expect(removeClaudeMdSnippet(withSnippet)).toBe('');
  });
});

describe('doInstall / doUninstall (filesystem, temp claude dir, --no-mcp via opts)', () => {
  it('installs into an empty claude dir', () => {
    const claudeDir = tmpDir();
    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(result.settingsChanged).toBe(true);
    expect(result.claudeMdChanged).toBe(true);
    expect(result.consolidateCopied).toBe(true);
    expect(result.mcp.attempted).toBe(false);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(hasOwnedHook(settings, ROOT, 'SessionStart', 'session-start')).toBe(true);
    const claudeMd = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(BEGIN_MARKER);
    const consolidate = fs.readFileSync(path.join(claudeDir, 'commands', 'consolidate.md'), 'utf8');
    expect(consolidate).toContain('<!-- engram-owned -->');
  });

  it('preserves unrelated hooks and plugins already in settings.json', () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      `${JSON.stringify(
        {
          enabledPlugins: { 'claude-mem@thedotmack': true, 'another@x': true },
          hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
          customKey: 42,
        },
        null,
        2,
      )}\n`,
    );
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.Notification).toEqual([{ hooks: [{ type: 'command', command: 'echo hi' }] }]);
    expect(settings.enabledPlugins).toEqual({ 'claude-mem@thedotmack': true, 'another@x': true });
    expect(settings.customKey).toBe(42);
  });

  it('a second install is a byte-for-byte no-op (idempotent)', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const settingsBefore = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8');
    const claudeMdBefore = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    const consolidateBefore = fs.readFileSync(path.join(claudeDir, 'commands', 'consolidate.md'), 'utf8');

    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(result.settingsChanged).toBe(false);
    expect(result.claudeMdChanged).toBe(false);
    expect(result.consolidateCopied).toBe(false);
    expect(result.backups).toEqual([]);

    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(claudeMdBefore);
    expect(fs.readFileSync(path.join(claudeDir, 'commands', 'consolidate.md'), 'utf8')).toBe(consolidateBefore);
  });

  it('uninstall restores unrelated settings.json and CLAUDE.md content byte-for-byte', () => {
    const claudeDir = tmpDir();
    const originalSettings = `${JSON.stringify(
      { enabledPlugins: { 'another@x': true }, hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      null,
      2,
    )}\n`;
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), originalSettings);
    const originalClaudeMd = '# My project\nSome notes the user wrote.\n';
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), originalClaudeMd);

    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const uninstallResult = doUninstall({ claudeDir, noMcp: true });
    expect(uninstallResult.settingsChanged).toBe(true);
    expect(uninstallResult.claudeMdChanged).toBe(true);

    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(originalSettings);
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(originalClaudeMd);
    // backups were made before each destructive edit
    expect(uninstallResult.backups.length).toBeGreaterThan(0);
    for (const b of uninstallResult.backups) expect(fs.existsSync(b)).toBe(true);
  });

  it('uninstall removes a CLAUDE.md file it created from nothing', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(true);
    doUninstall({ claudeDir, noMcp: true });
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
  });

  it('claude-mem disable/restore round-trips through install and uninstall', () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      `${JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }, null, 2)}\n`,
    );
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, disableClaudeMem: true });
    let settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins['claude-mem@thedotmack']).toBe(false);

    doUninstall({ claudeDir, noMcp: true });
    settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins['claude-mem@thedotmack']).toBe(true);
  });

  it('G6: install-state.json (not settings.json) holds the previous claude-mem value, mode 0600', () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      `${JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }, null, 2)}\n`,
    );
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, disableClaudeMem: true });
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.engram).toBeUndefined();

    const statePath = path.join(claudeDir, 'engram-install-state.json');
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.previousClaudeMem).toBe(true);
    expect(state.settingsCreated).toBe(false);
  });

  it('G6: a second install with disableClaudeMem does not clobber the recorded previous value', () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      `${JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }, null, 2)}\n`,
    );
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, disableClaudeMem: true });
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, disableClaudeMem: true });
    const statePath = path.join(claudeDir, 'engram-install-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.previousClaudeMem).toBe(true);

    doUninstall({ claudeDir, noMcp: true });
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins['claude-mem@thedotmack']).toBe(true);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('G6: a settings.json that existed before install (even as literal {}) is restored, not deleted', () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}\n');
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    doUninstall({ claudeDir, noMcp: true });
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('{}\n');
  });

  it('G6: a settings.json created by install is deleted on uninstall (unchanged behavior)', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    doUninstall({ claudeDir, noMcp: true });
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);
  });

  it('G6: uninstall removes an empty commands/ dir left vacant (e.g. its backup already cleared by hand)', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    doUninstall({ claudeDir, noMcp: true }); // leaves commands/<consolidate.md backup> behind
    const commandsDir = path.join(claudeDir, 'commands');
    expect(fs.existsSync(commandsDir)).toBe(true); // the backup from the line above still lives here
    for (const f of fs.readdirSync(commandsDir)) fs.rmSync(path.join(commandsDir, f)); // simulate drift
    doUninstall({ claudeDir, noMcp: true }); // a second, now-no-op uninstall still tidies up
    expect(fs.existsSync(commandsDir)).toBe(false);
  });

  it('G6: uninstall leaves the commands/ dir alone when something else still lives in it', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    fs.writeFileSync(path.join(claudeDir, 'commands', 'other.md'), '# not engram\n');
    doUninstall({ claudeDir, noMcp: true });
    expect(fs.existsSync(path.join(claudeDir, 'commands'))).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'commands', 'other.md'))).toBe(true);
  });

  it('G6: backups preserve the source file mode', () => {
    const claudeDir = tmpDir();
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, `${JSON.stringify({ enabledPlugins: { x: true } }, null, 2)}\n`);
    fs.chmodSync(settingsPath, 0o640);
    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(result.backups.length).toBeGreaterThan(0);
    const settingsBackup = result.backups.find((b) => b.includes('settings.json'))!;
    expect(fs.statSync(settingsBackup).mode & 0o777).toBe(0o640);
  });

  it('Task0: backups are written with the source mode atomically (fs.writeFileSync({ mode }), chmodSync belt-and-braces)', () => {
    const claudeDir = tmpDir();
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, `${JSON.stringify({ enabledPlugins: { x: true } }, null, 2)}\n`);
    fs.chmodSync(settingsPath, 0o640);

    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const backupCall = writeFileSyncSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('.engram-backup-') && call[0].includes('settings.json'),
    );
    writeFileSyncSpy.mockRestore();

    expect(backupCall).toBeDefined();
    // The mode must be passed to writeFileSync itself (atomic at creation), not applied only afterward.
    expect(backupCall![2]).toEqual({ mode: 0o640 });
  });

  it('dry-run writes nothing to disk', () => {
    const claudeDir = tmpDir();
    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.settingsChanged).toBe(true); // reports what WOULD change
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'commands'))).toBe(false);
  });

  it('does not overwrite a consolidate.md the user wrote themselves', () => {
    const claudeDir = tmpDir();
    fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
    const userFile = '# my own consolidate command\n';
    fs.writeFileSync(path.join(claudeDir, 'commands', 'consolidate.md'), userFile);

    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(result.consolidateCopied).toBe(false);
    expect(fs.readFileSync(path.join(claudeDir, 'commands', 'consolidate.md'), 'utf8')).toBe(userFile);
  });

  it('CLAUDE.md marker insert/replace/remove works end to end on disk', () => {
    const claudeDir = tmpDir();
    const original = '# Notes\nHand-written content.\n';
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), original);

    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const afterInstall = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    expect(afterInstall).toContain(original.trimEnd());
    expect(afterInstall).toContain(BEGIN_MARKER);

    // Re-install (simulating an upgrade with a changed snippet) replaces the block in place.
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const afterSecond = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
    expect(afterSecond).toBe(afterInstall);

    doUninstall({ claudeDir, noMcp: true });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(original);
  });
});

describe('MCP registration via the injectable runner (no real shell-out)', () => {
  function runnerReturning(
    byArgs: (args: string[]) => { status: number; stdout: string; stderr: string } | undefined,
    calls: string[][],
  ): (args: string[]) => { status: number; stdout: string; stderr: string } {
    return (args) => {
      calls.push(args);
      return byArgs(args) ?? { status: 0, stdout: '', stderr: '' };
    };
  }

  it('G3: not found (non-zero `get`) -> get then add', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning((args) => (args[1] === 'get' ? { status: 1, stdout: '', stderr: 'not found' } : undefined), calls);
    const result = doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([
      ['mcp', 'get', 'engram'],
      ['mcp', 'add', '--scope', 'user', 'engram', '--', EXEC_PATH, `${ROOT}/dist/mcp.js`],
    ]);
    expect(result.mcp.attempted).toBe(true);
    expect(result.mcp.status).toBe(0);
  });

  it('G3: "not found" text with a 0 status is still treated as not found -> get then add', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning(
      (args) => (args[1] === 'get' ? { status: 0, stdout: 'Error: MCP server engram not found.', stderr: '' } : undefined),
      calls,
    );
    doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([
      ['mcp', 'get', 'engram'],
      ['mcp', 'add', '--scope', 'user', 'engram', '--', EXEC_PATH, `${ROOT}/dist/mcp.js`],
    ]);
  });

  it('G3: found, registered to engram itself, but execPath/root differ -> get, remove, add (repair)', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning(
      (args) =>
        args[1] === 'get'
          ? { status: 0, stdout: 'engram:\n  Command: /old/node\n  Args: /old/root/dist/mcp.js\n', stderr: '' }
          : undefined,
      calls,
    );
    const result = doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([
      ['mcp', 'get', 'engram'],
      ['mcp', 'remove', '--scope', 'user', 'engram'],
      ['mcp', 'add', '--scope', 'user', 'engram', '--', EXEC_PATH, `${ROOT}/dist/mcp.js`],
    ]);
    expect(result.mcp.attempted).toBe(true);
  });

  it("G3: found, registered to engram itself, and already identical -> get only (no-op, never a duplicate add)", () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning(
      (args) =>
        args[1] === 'get'
          ? { status: 0, stdout: `engram:\n  Command: ${EXEC_PATH}\n  Args: ${ROOT}/dist/mcp.js\n`, stderr: '' }
          : undefined,
      calls,
    );
    const result = doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([['mcp', 'get', 'engram']]);
    expect(result.mcp.attempted).toBe(false);
    expect(result.mcp.noop).toBe(true);
  });

  it('Task0: equality is exact Command:/Args: parsing, not substring -- a longer differing path that merely contains the target is still a repair', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning(
      (args) =>
        args[1] === 'get'
          ? {
              status: 0,
              stdout: `engram:\n  Command: ${EXEC_PATH}-not-actually-the-same\n  Args: ${ROOT}/dist/mcp.js\n`,
              stderr: '',
            }
          : undefined,
      calls,
    );
    const result = doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([
      ['mcp', 'get', 'engram'],
      ['mcp', 'remove', '--scope', 'user', 'engram'],
      ['mcp', 'add', '--scope', 'user', 'engram', '--', EXEC_PATH, `${ROOT}/dist/mcp.js`],
    ]);
    expect(result.mcp.attempted).toBe(true);
  });

  it('Task0: unparseable Command:/Args: format (drift) falls back to remove+add even though "dist/mcp.js" appears in the output', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning(
      (args) =>
        args[1] === 'get'
          ? { status: 0, stdout: `engram -- ${EXEC_PATH} ${ROOT}/dist/mcp.js (some new CLI format)`, stderr: '' }
          : undefined,
      calls,
    );
    const result = doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([
      ['mcp', 'get', 'engram'],
      ['mcp', 'remove', '--scope', 'user', 'engram'],
      ['mcp', 'add', '--scope', 'user', 'engram', '--', EXEC_PATH, `${ROOT}/dist/mcp.js`],
    ]);
    expect(result.mcp.attempted).toBe(true);
  });

  it('G3: found but registered to something else entirely -> get only, skipped with a warning, never removed', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    const runner = runnerReturning(
      (args) => (args[1] === 'get' ? { status: 0, stdout: '/usr/bin/node /opt/some-other-server/index.js', stderr: '' } : undefined),
      calls,
    );
    const result = doInstall({ claudeDir, execPath: EXEC_PATH, mcpRunner: runner });
    expect(calls).toEqual([['mcp', 'get', 'engram']]);
    expect(result.mcp.attempted).toBe(false);
    expect(result.mcp.warning).toMatch(/isn't engram's own/);
  });

  it('Task0: uninstall runs `claude mcp get engram` first and only removes when it is engram\'s own (exact argv sequence)', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const runner = runnerReturning(
      (args) =>
        args[1] === 'get'
          ? { status: 0, stdout: `engram:\n  Command: ${EXEC_PATH}\n  Args: ${ROOT}/dist/mcp.js\n`, stderr: '' }
          : undefined,
      calls,
    );
    const result = doUninstall({ claudeDir, mcpRunner: runner });
    expect(calls).toEqual([
      ['mcp', 'get', 'engram'],
      ['mcp', 'remove', '--scope', 'user', 'engram'],
    ]);
    expect(result.mcp.attempted).toBe(true);
  });

  it("Task0: uninstall against a foreign 'engram' MCP server -> get only, warning, never removed", () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const runner = runnerReturning(
      (args) =>
        args[1] === 'get' ? { status: 0, stdout: '/usr/bin/node /opt/some-other-server/index.js', stderr: '' } : undefined,
      calls,
    );
    const result = doUninstall({ claudeDir, mcpRunner: runner });
    expect(calls).toEqual([['mcp', 'get', 'engram']]);
    expect(result.mcp.attempted).toBe(false);
    expect(result.mcp.warning).toMatch(/isn't engram's own/);
  });

  it('Task0: uninstall when no engram MCP server is registered -> get only, nothing to remove', () => {
    const claudeDir = tmpDir();
    const calls: string[][] = [];
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const runner = runnerReturning(
      (args) => (args[1] === 'get' ? { status: 1, stdout: '', stderr: 'not found' } : undefined),
      calls,
    );
    const result = doUninstall({ claudeDir, mcpRunner: runner });
    expect(calls).toEqual([['mcp', 'get', 'engram']]);
    expect(result.mcp.attempted).toBe(false);
  });

  it('hookCommandFor builds the quoted, absolute-path, marker-carrying command string', () => {
    expect(hookCommandFor(EXEC_PATH, '/opt/engram', 'session-start')).toBe(
      `ENGRAM_HOOK=1 "${EXEC_PATH}" "/opt/engram/dist/cli.js" session-start || true`,
    );
  });
});

describe('G3: stale execPath / root repair + detection (pure mergeHooks)', () => {
  const root = '/opt/engram';

  it('install with execPath A then B repairs every event to B, one owned entry each', () => {
    const a = mergeHooks({}, root, { execPath: '/old/node' });
    const b = mergeHooks(a, root, { execPath: '/new/node' });
    const hooks = b.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event]![0]!.hooks[0]!.command).toContain('/new/node');
      expect(hooks[event]![0]!.hooks[0]!.command).not.toContain('/old/node');
    }
  });

  it('a second install is still byte-identical (no spurious repair) when nothing changed', () => {
    const once = mergeHooks({}, root, { execPath: EXEC_PATH });
    const twice = mergeHooks(once, root, { execPath: EXEC_PATH });
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('owned entries left behind by a different root collapse into exactly one, from the newer root', () => {
    const fromOldRoot = mergeHooks({}, '/old/root', { execPath: EXEC_PATH });
    const repaired = mergeHooks(fromOldRoot, '/new/root', { execPath: EXEC_PATH });
    const hooks = repaired.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event]![0]!.hooks[0]!.command).toContain('/new/root');
    }
  });

  it('ownership is detected across a changed root via the ENGRAM_HOOK=1 marker, not just execPath', () => {
    const settings = mergeHooks({}, '/some/root', { execPath: EXEC_PATH });
    expect(hasOwnedHook(settings, '/a/totally/different/root', 'SessionStart', 'session-start')).toBe(true);
  });
});

describe('G3: doctor repair diagnostics (parseHookCommand, stale node path)', () => {
  it('parseHookCommand extracts execPath and root from the marker format', async () => {
    const { parseHookCommand } = await import('../src/cli/commands/install.js');
    expect(parseHookCommand(hookCommandFor('/usr/bin/node', '/opt/engram', 'session-start'))).toEqual({
      execPath: '/usr/bin/node',
      root: '/opt/engram',
    });
  });

  it('flags a missing node path and a differing one', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: '/no/such/node-binary' });
    const missingReport = doDoctor({ claudeDir, noMcp: true });
    expect(missingReport).toMatch(/node: missing/);

    const claudeDir2 = tmpDir();
    doInstall({ claudeDir: claudeDir2, noMcp: true, execPath: process.execPath });
    // Simulate "the recorded execPath still exists, but differs from what's running doctor now" by
    // re-pointing settings.json at a second, also-real executable (bash) so the node existence check
    // passes while the identity check still differs from process.execPath.
    const settingsPath = path.join(claudeDir2, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    settings.hooks = JSON.parse(JSON.stringify(settings.hooks).split(process.execPath).join('/bin/bash'));
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const differsReport = doDoctor({ claudeDir: claudeDir2, noMcp: true });
    expect(differsReport).toMatch(/node: differs from current/);
  });
});

describe('Task0: root-change notice (D30 guard)', () => {
  it('doInstall reports rootChanged when it repairs an owned entry pointing at a different root', () => {
    const claudeDir = tmpDir();
    const fakeRoot = makeFakeEngramRoot();

    const first = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, root: ROOT });
    expect(first.rootChanged).toBeUndefined();

    const second = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, root: fakeRoot });
    expect(second.rootChanged).toEqual({ from: ROOT, to: fakeRoot });

    // A third install at the same (new) root is not a root change.
    const third = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, root: fakeRoot });
    expect(third.rootChanged).toBeUndefined();
  });

  it('a fresh install (no prior owned entry) never reports rootChanged', () => {
    const claudeDir = tmpDir();
    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, root: ROOT });
    expect(result.rootChanged).toBeUndefined();
  });

  it('an execPath-only change (same root) does not report rootChanged', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: '/old/node', root: ROOT });
    const result = doInstall({ claudeDir, noMcp: true, execPath: '/new/node', root: ROOT });
    expect(result.rootChanged).toBeUndefined();
  });

  it('installCommand prints the exact root-repointed notice to stdout', () => {
    const claudeDir = tmpDir();
    const fakeRoot = makeFakeEngramRoot();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, root: ROOT });

    // doInstall (not the CLI's own root resolution) is what the installer always uses in practice --
    // a real root change happens by reinstalling from a different worktree, i.e. a different
    // `resolveEngramRoot()` result, not a CLI flag. Exercise the CLI's own print path directly by
    // calling doInstall and feeding its result through the same formatting installCommand uses,
    // confirmed indirectly via installCommand's own stdout when root is passed through InstallOpts.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH, root: fakeRoot });
    expect(result.rootChanged).toEqual({ from: ROOT, to: fakeRoot });
    installCommand(['--claude-dir', claudeDir, '--no-mcp']);
    const printed = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    // The CLI's own resolveEngramRoot() (ROOT) matches what's already installed (fakeRoot's hooks
    // are still owned, but a plain re-run from ROOT is itself a second, real root change back to ROOT).
    expect(printed).toContain(`engram: hooks re-pointed from ${fakeRoot} to ${ROOT}`);
  });
});

function listBackups(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listBackups(full));
    else if (entry.name.includes('.engram-backup-')) out.push(full);
  }
  return out;
}

describe('settings.json formatting is preserved (Review item 1)', () => {
  it('round-trips a 4-space-indented settings.json byte-for-byte through install then uninstall', () => {
    const claudeDir = tmpDir();
    const original = `${JSON.stringify(
      { enabledPlugins: { 'claude-mem@thedotmack': true }, hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      null,
      4,
    )}\n`;
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), original);
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toContain('\n    "enabledPlugins"');
    doUninstall({ claudeDir, noMcp: true });
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(original);
  });

  it('round-trips a tab-indented settings.json byte-for-byte through install then uninstall', () => {
    const claudeDir = tmpDir();
    const original = `${JSON.stringify(
      { enabledPlugins: { 'claude-mem@thedotmack': true }, hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      null,
      '\t',
    )}\n`;
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), original);
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toContain('\n\t"enabledPlugins"');
    doUninstall({ claudeDir, noMcp: true });
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(original);
  });
});

describe('CLAUDE.md malformed markers abort the whole run (Review item 2)', () => {
  function expectAbortsWithoutWriting(claudeDir: string, claudeMdBefore: string, settingsBefore: string | undefined): void {
    const settingsPath = path.join(claudeDir, 'settings.json');
    expect(() => doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH })).toThrow(MALFORMED_MARKERS_MESSAGE);
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(claudeMdBefore);
    expect(fs.existsSync(settingsPath)).toBe(settingsBefore !== undefined);
    if (settingsBefore !== undefined) expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(listBackups(claudeDir)).toEqual([]);

    expect(() => doUninstall({ claudeDir, noMcp: true })).toThrow(MALFORMED_MARKERS_MESSAGE);
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(claudeMdBefore);
    expect(fs.existsSync(settingsPath)).toBe(settingsBefore !== undefined);
    if (settingsBefore !== undefined) expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(listBackups(claudeDir)).toEqual([]);
  }

  it('aborts on duplicate blocks', () => {
    const claudeDir = tmpDir();
    const claudeMd = `# Notes\n${BEGIN_MARKER}\none\n${END_MARKER}\n\n${BEGIN_MARKER}\ntwo\n${END_MARKER}\n`;
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), claudeMd);
    expectAbortsWithoutWriting(claudeDir, claudeMd, undefined);
  });

  it('aborts on a begin marker with no matching end marker', () => {
    const claudeDir = tmpDir();
    const claudeMd = `# Notes\n${BEGIN_MARKER}\nunterminated\n`;
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), claudeMd);
    expectAbortsWithoutWriting(claudeDir, claudeMd, undefined);
  });

  it('aborts on an end marker with no matching begin marker', () => {
    const claudeDir = tmpDir();
    const claudeMd = `# Notes\nstray\n${END_MARKER}\n`;
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), claudeMd);
    expectAbortsWithoutWriting(claudeDir, claudeMd, undefined);
  });
});

describe('corrupt settings.json aborts without writing (Review item 3)', () => {
  it('install exits non-zero, writes nothing, and makes no backup', () => {
    const claudeDir = tmpDir();
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{ not json');
    expect(() => doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH })).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
    expect(listBackups(claudeDir)).toEqual([]);
  });

  it('uninstall exits non-zero, writes nothing, and makes no backup', () => {
    const claudeDir = tmpDir();
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{ not json');
    expect(() => doUninstall({ claudeDir, noMcp: true })).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
    expect(listBackups(claudeDir)).toEqual([]);
  });

  it('the CLI exits 1 and prints the error on stderr', () => {
    const claudeDir = tmpDir();
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ not json');
    const r = runCli(['install', '--claude-dir', claudeDir, '--no-mcp'], { dbFile: tmpDbFile() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('engram install:');
  });
});

describe('consolidate.md uninstall ownership (Review item 4)', () => {
  it('removes an engram-owned copy on uninstall', () => {
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const consolidatePath = path.join(claudeDir, 'commands', 'consolidate.md');
    expect(fs.readFileSync(consolidatePath, 'utf8')).toContain(ENGRAM_OWNED_MARKER);
    const result = doUninstall({ claudeDir, noMcp: true });
    expect(result.consolidateRemoved).toBe(true);
    expect(fs.existsSync(consolidatePath)).toBe(false);
  });

  it('leaves a user-owned consolidate.md (no marker) byte-identical on uninstall', () => {
    const claudeDir = tmpDir();
    fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
    const consolidatePath = path.join(claudeDir, 'commands', 'consolidate.md');
    const userFile = '# my own consolidate command, no marker here\n';
    fs.writeFileSync(consolidatePath, userFile);
    const result = doUninstall({ claudeDir, noMcp: true });
    expect(result.consolidateRemoved).toBe(false);
    expect(fs.readFileSync(consolidatePath, 'utf8')).toBe(userFile);
  });
});

describe('path quoting safety (Review item 5)', () => {
  it('hookCommand rejects an execPath or root containing a double quote', () => {
    expect(() => hookCommand('/usr/bin/no"de', '/root', 'session-start')).toThrow(/double-quote/);
    expect(() => hookCommand('/usr/bin/node', '/ro"ot', 'session-start')).toThrow(/double-quote/);
  });

  it('doInstall aborts without writing when execPath contains a double quote', () => {
    const claudeDir = tmpDir();
    expect(() => doInstall({ claudeDir, noMcp: true, execPath: '/usr/bin/no"de' })).toThrow(/double-quote/);
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);
  });

  it('quotes a root containing a space so it survives sh -c as a single argument', () => {
    const rootWithSpace = path.join(tmpDir(), 'has space');
    fs.mkdirSync(rootWithSpace, { recursive: true });
    const cmd = hookCommandFor('/usr/bin/fake-node', rootWithSpace, 'session-start');
    // Stand in `printf '%s\n'` for the real binary: it echoes each remaining argv entry on its own
    // line, so if the quoted root-with-space path were split by the shell into two arguments, the
    // spaced path would be broken across two lines instead of appearing whole on one.
    const probeCmd = cmd.replace('"/usr/bin/fake-node"', `printf '%s\\n'`);
    const out = execFileSync('sh', ['-c', probeCmd], { encoding: 'utf8' });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual([`${rootWithSpace}/dist/cli.js`, 'session-start']);
  });
});

describe('unique backup names (Review item 6)', () => {
  it('appends -1, -2, ... when the base path is already taken', () => {
    const dir = tmpDir();
    const base = path.join(dir, 'settings.json.engram-backup-2026-10-01T00-00-00-000Z');
    expect(uniqueBackupPath(base)).toBe(base);

    fs.writeFileSync(base, 'x');
    expect(uniqueBackupPath(base)).toBe(`${base}-1`);

    fs.writeFileSync(`${base}-1`, 'y');
    expect(uniqueBackupPath(base)).toBe(`${base}-2`);
  });
});

describe('engram doctor', () => {
  it('reports "no database yet" and does not create one', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const claudeDir = tmpDir();
    const report = doDoctor({ claudeDir, noMcp: true });
    expect(report).toContain('no database yet');
    expect(fs.existsSync(dbFile)).toBe(false);
  });

  it('reports hook/snippet install status under the given claude dir', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const claudeDir = tmpDir();
    doInstall({ claudeDir, noMcp: true, execPath: EXEC_PATH });
    const report = doDoctor({ claudeDir, noMcp: true });
    expect(report).toMatch(/SessionStart\s+installed/);
    expect(report).toContain('installed');
    expect(report).toContain('spool backlog: 0');
  });

  it('Task0: native-module check actually instantiates a Database, not just require() -- reports ok against the real build', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const claudeDir = tmpDir();
    // A real install, using this process's own node and the real repo root (real better-sqlite3 build).
    doInstall({ claudeDir, noMcp: true, execPath: process.execPath });
    const report = doDoctor({ claudeDir, noMcp: true });
    expect(report).toContain('native module: ok');
  });

  it('Task0: native-module check reports "failed" against a corrupted better-sqlite3 prebuild (garbage .node file)', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const claudeDir = tmpDir();
    const fakeRoot = tmpDir();
    fs.mkdirSync(path.join(fakeRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'dist', 'cli.js'), '// stub\n');

    const srcModule = path.join(ROOT, 'node_modules', 'better-sqlite3');
    const fakeModule = path.join(fakeRoot, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(path.dirname(fakeModule), { recursive: true });
    fs.cpSync(srcModule, fakeModule, { recursive: true });

    const prebuildName = `${process.platform}-${process.arch}.node`;
    const prebuildFile = path.join(fakeModule, 'prebuilds', prebuildName);
    expect(fs.existsSync(prebuildFile)).toBe(true); // sanity: this platform ships a prebuild to corrupt
    fs.writeFileSync(prebuildFile, 'not a real native addon, just garbage bytes');

    // Write settings.json directly (mergeHooks is pure) so the recorded root is the fake, corrupted one.
    const settings = mergeHooks({}, fakeRoot, { execPath: process.execPath });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const report = doDoctor({ claudeDir, noMcp: true });
    expect(report).toMatch(/node: ok/);
    expect(report).toMatch(/root: ok/);
    expect(report).toContain('native module: failed');
  });

  it('G6: doctor opens the DB read-only and never changes its mode or triggers a write', async () => {
    const { openDb } = await import('../src/storage/db.js');
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const db = openDb(dbFile);
    db.close();
    fs.chmodSync(dbFile, 0o400); // simulate a DB file openDb's own chmod(0600) would otherwise "fix"

    const claudeDir = tmpDir();
    const report = doDoctor({ claudeDir, noMcp: true });
    // D42/Phase 6 Task 2 bumped SCHEMA_VERSION to 3 (embeddings table).
    expect(report).toContain('schema v3');
    expect(fs.statSync(dbFile).mode & 0o777).toBe(0o400); // doctor never chmod'd it back

    fs.chmodSync(dbFile, 0o600); // restore so the OS can clean up the temp dir afterward
  });

  it('G5: counts hooks.log error lines from the last 24h and lists .bad spool files', () => {
    const dbFile = tmpDbFile();
    useDb(dbFile);
    const dataDirPath = path.dirname(dbFile);
    fs.mkdirSync(dataDirPath, { recursive: true });
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(dataDirPath, 'hooks.log'),
      [
        `${recent} [ingest-prompt] Error: boom\n`,
        `${recent} [session-start] database locked; deferred\n`,
        `${old} [ingest-prompt] Error: ancient\n`,
      ].join(''),
    );
    const spoolDirPath = path.join(dataDirPath, 'spool');
    fs.mkdirSync(spoolDirPath, { recursive: true });
    fs.writeFileSync(path.join(spoolDirPath, 'corrupt-1.json.bad'), 'not json');

    const claudeDir = tmpDir();
    const report = doDoctor({ claudeDir, noMcp: true });
    expect(report).toContain('1 error line(s) in the last 24h');
    expect(report).toContain('spool .bad files: 1');
    expect(report).toContain('corrupt-1.json.bad');
  });
});

describe('engram install/uninstall/doctor CLI (subprocess, always --no-mcp)', () => {
  it('install then doctor then uninstall round-trip via the CLI', () => {
    const claudeDir = tmpDir();
    const dbFile = tmpDbFile();
    const install = runCli(['install', '--claude-dir', claudeDir, '--no-mcp'], { dbFile });
    expect(install.status).toBe(0);
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);

    const doctor = runCli(['doctor', '--claude-dir', claudeDir, '--no-mcp'], { dbFile });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('no database yet');

    const uninstall = runCli(['uninstall', '--claude-dir', claudeDir, '--no-mcp'], { dbFile });
    expect(uninstall.status).toBe(0);
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);
  });
});
