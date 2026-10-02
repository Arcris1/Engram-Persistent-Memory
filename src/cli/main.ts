import { VERSION } from '../version.js';
import { statsCommand } from './commands/stats.js';
import { doctorCommand, installCommand, uninstallCommand } from './commands/install.js';
import { exportCommand } from './commands/export.js';
import { explainCommand } from './commands/explain.js';
import { forgetCommand } from './commands/forget.js';
import { importCommand } from './commands/import.js';
import { ingestPromptCommand } from './commands/ingest-prompt.js';
import { ingestTranscriptCommand } from './commands/ingest-transcript.js';
import { listCommand } from './commands/list.js';
import { pauseCommand, resumeCommand, statusCommand } from './commands/pause.js';
import { rebuildCommand } from './commands/rebuild.js';
import { sessionEndCommand } from './commands/session-end.js';
import { sessionStartCommand } from './commands/session-start.js';

type Command = (args: string[]) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  stats: statsCommand,
  install: installCommand,
  uninstall: uninstallCommand,
  doctor: doctorCommand,
  'ingest-prompt': () => ingestPromptCommand(),
  'ingest-transcript': () => ingestTranscriptCommand(),
  'session-start': () => sessionStartCommand(),
  'session-end': () => sessionEndCommand(),
  pause: () => pauseCommand(),
  resume: () => resumeCommand(),
  status: () => statusCommand(),
  export: exportCommand,
  import: importCommand,
  list: listCommand,
  explain: explainCommand,
  forget: forgetCommand,
  rebuild: () => rebuildCommand(),
  // Phase 6 review: these may pull in src/embed/* (and, lazily, onnxruntime-node), so they are loaded
  // only when actually run -- hook processes (session-start/ingest-*/session-end) never touch them.
  maintain: async (args) => (await import('./commands/maintain.js')).maintainCommand(args),
  model: async (args) => (await import('./commands/model.js')).modelCommand(args),
  embed: async (args) => (await import('./commands/embed.js')).embedCommand(args),
  // D45: the local web UI is a separate package; this only spawns it. Hooks never load it.
  ui: async (args) => (await import('./commands/ui.js')).uiCommand(args),
};

const USAGE = `engram ${VERSION}
usage: engram <command> [options]

commands:
  stats [--json]        show database statistics
  doctor [--claude-dir <dir>] [--no-mcp]
                         report DB, hooks, MCP registration, CLAUDE.md snippet and spool status

installer commands (Claude Code user scope, default --claude-dir ~/.claude):
  install [--claude-dir <dir>] [--dry-run] [--no-mcp] [--disable-claude-mem]
                         register hooks + MCP server, install the /consolidate command and the
                         CLAUDE.md memory snippet
  uninstall [--claude-dir <dir>] [--dry-run] [--no-mcp]
                         reverse everything 'install' did, restoring prior content byte-for-byte

hook commands (read Claude Code hook JSON on stdin; always exit 0; only session-start prints):
  session-start         SessionStart: print the memory profile for this project
  session-end           SessionEnd: close the session and ingest the final transcript
  ingest-prompt         UserPromptSubmit: append the user's prompt
  ingest-transcript     Stop/PreCompact: append new assistant turns from the transcript

control commands:
  pause                  stop every hook and write tool from touching the database
  resume                 undo 'pause'
  status                 print 'paused' or 'active'
  export [--out <file>]  write a JSON export of the whole database and print its path
  import <file>          additively restore an export; never overwrites an existing row
  list [--claims|--events] [--limit N] [--project P]
                         print active claims (default) or events, one per line
  explain <id>           show why a claim or event is remembered (its full chain)
  forget <id> [--yes]    preview what would be deleted; only deletes with --yes
  rebuild                 rebuild events_fts/claims_fts and recompute every claim's importance
  maintain [--embed]      rebuild, then PRAGMA optimize, then wal_checkpoint(TRUNCATE); --embed also
                           backfills all missing/stale vectors first, same as embed
                           (D42, optional feature, no-op if embedding isn't enabled/usable)
  model verify            sha256-verify + load the configured embedding model, print ok/reason,
                           dim and a self-similarity sanity check (D42, optional feature)
  embed [--limit N]       backfill ALL missing/stale vectors in batches (--limit N caps this run;
                           prints remaining)
                           (D42, optional feature; refuses if embedding isn't enabled/usable)
  ui [--port N] [--no-open]
                         open the local web UI (loopback only; Ctrl+C to stop; D45)
`;

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (name === '--help' || name === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (name === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`engram: unknown command '${name}'\n\n${USAGE}`);
    return 1;
  }
  // Friendly CLI errors: any thrown error from a command surfaces as a single `engram: <message>`
  // line on stderr with exit 1 -- never a raw stack trace, unless ENGRAM_DEBUG=1 explicitly asks for
  // one. Hook commands are unaffected: they already catch their own errors and always exit 0.
  try {
    return await command(rest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`engram: ${message}\n`);
    if (process.env.ENGRAM_DEBUG === '1' && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    return 1;
  }
}
