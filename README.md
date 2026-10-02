# engram

Local-first, inspectable memory for [Claude Code](https://claude.com/claude-code).

engram records what you and Claude say in your sessions into a SQLite database on your own machine,
turns the durable parts into short, cited **memories**, and hands the relevant ones back to Claude at
the start of each session. Everything stays local: no account, no cloud, no network calls. You can
see exactly what is stored, why it is there, and delete any of it.

- **Append-only record.** Every captured message is kept as an event; memories ("claims") are derived
  from events and always cite the messages they came from.
- **Yours to inspect and delete.** A CLI, a local web UI and Claude's own memory tools all show the
  same data. Forgetting always previews first and erases for good.
- **Safe by default.** Secrets are redacted before they reach disk, text that looks like an
  instruction is never injected back into a session, and the core package contains no network code.
- **Optional semantic search.** A small local embedding model can be switched on with one script.

## Contents

- [Requirements](#requirements)
- [Install](#install) (macOS, Linux, Windows)
- [Check that it works](#check-that-it-works)
- [Daily use](#daily-use)
- [The UI](#the-ui)
- [Semantic search (optional)](#semantic-search-optional)
- [Command reference](#command-reference)
- [Configuration](#configuration)
- [Upgrading and uninstalling](#upgrading-and-uninstalling)
- [Maintenance](#maintenance)
- [Privacy and security](#privacy-and-security)
- [How well does retrieval work?](#how-well-does-retrieval-work)
- [Development](#development)

## Requirements

| | |
|---|---|
| Node.js | 22 or newer (`node --version`) |
| Claude Code | installed, with the `claude` command on your PATH |
| git | to fetch this repository |
| Disk | about 450 MB for dependencies (about 290 MB of that is the optional semantic-search runtime) |
| Optional | the `sqlite3` command-line tool, for file-level backups |

engram uses the native module `better-sqlite3`. Prebuilt binaries exist for common platforms; if
yours has none, npm compiles it and needs a C++ toolchain (Xcode Command Line Tools on macOS,
`build-essential` and `python3` on Debian/Ubuntu).

## Install

Install engram into its own folder, **outside** your projects and not inside `~/.engram` (that folder
is the database's home). The steps below use `~/.engram-app`.

### macOS and Linux

```sh
git clone https://github.com/Arcris1/Engram-Persistent-Memory.git ~/.engram-app
cd ~/.engram-app
npm ci
npm run build
node dist/cli.js install
node dist/cli.js doctor
```

On Debian/Ubuntu, install the prerequisites first if you do not have them:

```sh
sudo apt-get update && sudo apt-get install -y git build-essential python3 sqlite3
# Node 22: use nvm (https://github.com/nvm-sh/nvm) and run: nvm install 22
```

### Windows

Use **WSL2** (Windows Subsystem for Linux) and install both Claude Code and engram inside it:

1. In PowerShell (as administrator): `wsl --install`, then restart and open the Ubuntu terminal.
2. Inside Ubuntu, install Node 22, git and Claude Code, then follow the **macOS and Linux** steps above.
3. Run Claude Code from the WSL terminal. engram's database then lives in your WSL home (`~/.engram`).

Native Windows (PowerShell or cmd, without WSL) is **not supported yet and is untested**: the hook
commands engram registers are POSIX shell lines, and `scripts/enable-semantic-search.sh` is a bash
script. The UI has no Windows launcher either; under WSL, run `engram ui --no-open` and paste the
printed URL into your Windows browser.

### What `install` does

`node dist/cli.js install` changes only your Claude Code user configuration (`~/.claude`):

- registers engram's hooks in `settings.json` (a timestamped backup of the file is written first);
- registers the `engram` MCP server, so Claude gets the memory tools (this runs `claude mcp add`);
- adds a short "Memory (engram)" section to `~/.claude/CLAUDE.md`, telling Claude when to use them;
- installs the `/consolidate` command.

Flags: `--dry-run` shows what would change, `--no-mcp` skips the MCP registration, `--claude-dir <dir>`
targets another Claude Code config folder, `--disable-claude-mem` turns off the `claude-mem` plugin if
you are replacing it. If `claude` is not on your PATH or does not answer within 30 seconds, `install`
leaves the hooks installed, reports the MCP step as an error and exits 1; run it again once `claude`
is available.

Tip: add a shortcut so you can type `engram` instead of the full path:

```sh
echo "alias engram='node ~/.engram-app/dist/cli.js'" >> ~/.zshrc   # or ~/.bashrc
```

The rest of this README writes `engram <command>`; without the alias use
`node ~/.engram-app/dist/cli.js <command>`.

## Check that it works

```sh
engram doctor     # hooks, MCP registration, database, recent hook errors
engram stats      # how much has been captured
```

Then start a **new** Claude Code session, say something worth remembering ("remember that I prefer
pnpm"), and look at it:

```sh
engram list --events --limit 5
```

## Daily use

1. **Capture is automatic.** Hooks record your prompts and Claude's replies as you work. Nothing else
   is needed.
2. **Turn sessions into memories.** Run `/consolidate` in Claude Code at the end of a substantial
   session (or whenever you like). Claude reads the unconsolidated sessions and writes short, cited
   memories. Until you do this, sessions are captured but nothing is injected.
3. **Memories come back on their own.** At the start of each session Claude receives a short profile
   of relevant memories, marked as stored data rather than instructions, and searches memory when you
   refer to something from before ("the bug we fixed", "what did we decide").
4. **Say it in plain words.** "Remember this", "forget that", "always keep this in mind" make Claude
   record, forget (with a preview) or pin a memory.

Useful commands:

```sh
engram list                 # current memories
engram list --events        # captured messages
engram explain <id>         # why a memory exists and what it was built from
engram forget <id>          # preview what would be erased; add --yes to erase
engram pause / resume       # stop and restart all capture
engram export               # one JSON file with everything
```

Forgetting is **per item**: it erases that memory or message, its search entries and anything built
only from it. The preview lists what stays (for example another message with the same text), so you
can forget those too if the text itself must go. An export file made earlier is not touched.

## The UI

```sh
engram ui                # starts a local page and opens your browser
engram ui --port 48000   # start looking for a free port at 48000 (default 47800)
engram ui --no-open      # print the URL without opening a browser
```

It prints a URL such as `http://127.0.0.1:47800/#token=...`. The token is random and new on every
launch. Press Ctrl+C to stop.

- **Overview**: what Claude is told when a session starts, whether capture is on, how many sessions
  are waiting for `/consolidate`, and the last 14 days of activity.
- **Memories**: search and filter memories or the captured messages behind them. Selecting one shows
  **where it came from**: the exact messages it was built from, and the memory it replaced.
  Pin a memory to send it to every session.
- **Forget**: a preview of what will be erased and what stays, then a second click to confirm.
- **Health**: whether each hook and the memory tools are working, where the database is, and an
  export button.

The page is served from your machine only (127.0.0.1), needs the per-launch token for every request,
rejects requests coming from other websites, bundles its own fonts and never contacts the internet.
Search in the UI is keyword-only, and browsing never counts as Claude "using" a memory. On a shared
computer other local users could briefly see the token in the process list while the browser opens;
use `--no-open` if that matters. To try the UI on sample data without touching your own database,
run `npm run ui:demo` in the repository.

## Semantic search (optional)

Off by default. When on, Claude's memory search also matches by meaning, so a question worded
differently from the stored memory can still find it. It runs a small model
(`all-MiniLM-L6-v2`, quantized, about 23 MB) entirely on your machine.

```sh
~/.engram-app/scripts/enable-semantic-search.sh          # download the model, verify it, switch it on
~/.engram-app/scripts/enable-semantic-search.sh --from DIR   # use model files you copied yourself (no download)
~/.engram-app/scripts/enable-semantic-search.sh --off    # switch it off again
```

The script finds your install, downloads three model files, checks each file's sha256, adds an
`embedding` block to `~/.engram/config.json` (keeping a backup), verifies the model and embeds your
existing memories. Start a new Claude Code session afterwards. It is the only thing in this
repository that downloads anything, and only when you run it; engram itself never does.

<details>
<summary>Manual steps and details</summary>

1. Put `onnx/model_quantized.onnx` (saved as `model_quantized.onnx`), `tokenizer.json` and
   `tokenizer_config.json` from the `Xenova/all-MiniLM-L6-v2` model repository into one folder, for
   example `~/.engram/models/all-MiniLM-L6-v2/`.
2. Check the hash: `shasum -a 256 ~/.engram/models/all-MiniLM-L6-v2/model_quantized.onnx` should print
   `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` (the file the evaluation used).
3. Add to `~/.engram/config.json`:

   ```json
   {
     "embedding": {
       "enabled": true,
       "modelDir": "~/.engram/models/all-MiniLM-L6-v2",
       "sha256": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
     }
   }
   ```

   `modelDir` must be absolute or start with `~`.
4. `engram model verify` (prints `ok` or the reason it refused), then `engram embed`.
5. Start a new Claude Code session; a running one keeps the setting it started with.

Notes:

- The model's hash is checked before it is loaded; hooks never load it; nothing is downloaded at
  runtime.
- New memories written by Claude are embedded immediately. Messages captured by hooks are embedded
  lazily (up to 32 per search); `engram embed` or `engram maintain --embed` catches up on the rest.
- Vectors are derived data: `forget` deletes them with their source, `export` leaves them out, and
  after an `import` you run `engram embed` again.
- Cost: at 20,000 embedded items a search takes roughly 85-110 ms instead of about 5 ms. Typical
  databases are far smaller.
- `npm ci --omit=optional` skips the model runtime (about 290 MB) but also the UI's build tooling, so
  the build then stops at the UI step and `engram ui` is unavailable; the rest of engram still works.

</details>

## Command reference

```
engram install | uninstall     register / remove hooks, MCP server, CLAUDE.md section, /consolidate
engram doctor                  check the install
engram stats [--json]          counts, size, schema version
engram list [--claims|--events] [--limit N] [--project P]
engram explain <id>            the full chain behind a memory or message
engram forget <id> [--yes]     preview, then erase
engram pause | resume | status stop / restart capture
engram export [--out <file>]   JSON snapshot of the whole database (file mode 0600)
engram import <file>           additive restore; never overwrites an existing row
engram rebuild                 rebuild the search index and recompute importance
engram maintain [--embed]      rebuild + optimize + checkpoint (for a daily schedule)
engram model verify            check the configured embedding model
engram embed [--limit N]       embed anything not embedded yet
engram ui [--port N] [--no-open]
```

Claude gets the same abilities as tools: `memory_search`, `memory_record`, `memory_profile`,
`memory_explain`, `memory_forget`, `memory_pin`, `memory_unpin`, `memory_feedback`, `memory_stats`,
`memory_pending`, `memory_claim_upsert`, `memory_rebuild` and `memory_reset_claims`.

Imported memories stay out of the session profile until you pin them, and imported pins are dropped:
an export file is treated as untrusted input once it has left the database.

## Configuration

| What | Where | Default |
|---|---|---|
| Database | `~/.engram/engram.db` (folder mode 0700, file mode 0600) | set `ENGRAM_DB` to an absolute path to move it |
| Settings | `~/.engram/config.json` | none needed |
| Hook log | `~/.engram/hooks.log` | |
| Pause flag | `~/.engram/paused` | absent |

`config.json` keys: `embedding` (see above) and `ingestToolResults` (`false` by default; when `true`,
tool results are captured too).

## Upgrading and uninstalling

Close your Claude Code sessions first, back up, then update in place:

```sh
cd ~/.engram-app
sqlite3 ~/.engram/engram.db ".backup $HOME/.engram/backup-$(date +%Y%m%d%H%M%S).db"   # or: engram export
git pull
npm ci && npm run build
node dist/cli.js install     # re-registers hooks and the MCP server against the new build
node dist/cli.js stats       # runs any pending database migration
node dist/cli.js doctor
```

Run `install` and `doctor` again after changing your Node version too (the hooks record the path of
the `node` binary). If a newer build migrated the database and you need to go back, restore the
backup file.

To remove engram: `node ~/.engram-app/dist/cli.js uninstall` restores your Claude Code configuration
to what it was before. Your database in `~/.engram` is left alone; delete that folder yourself if you
want the data gone.

## Maintenance

`engram maintain` rebuilds the search index, recomputes importance, refreshes SQLite's statistics and
truncates the write-ahead log. Nothing schedules it for you. A daily cron line (use absolute paths;
add `--embed` if semantic search is on):

```
0 3 * * * /usr/bin/env node /home/you/.engram-app/dist/cli.js maintain >> /home/you/.engram/maintain.log 2>&1
```

## Privacy and security

- **Local only.** The core package has no network code, and a test fails if any appears.
  The optional UI listens on 127.0.0.1 only and makes no outbound requests.
- **Secrets are redacted before they are written.** API keys, tokens and `key=value` credentials are
  replaced at capture time.
- **Stored text is data, not instructions.** Everything handed back to Claude is wrapped as stored
  memory. Text that looks like an instruction ("ignore your instructions and ...") is flagged at
  capture and never injected automatically.
- **One delete path.** `forget` always previews first, then erases the item, its search entries,
  its vectors and anything built only from it, and prevents it from being re-created from the same
  transcript.
- **A pause switch.** `engram pause` makes every hook a no-op and every write tool refuse.
- **Private files.** The database folder is created with mode 0700 and the database, exports and
  config with mode 0600.

## How well does retrieval work?

Honestly: useful, not perfect. The project set itself a target of finding the right memory in the top
five results at least 80% of the time and returning nothing for questions it has no memory of. It was
measured on question sets written without seeing any results. These numbers are from the
second set (19 recall questions, 12 that should return nothing):

| | Recall (right memory in top 5) | Returns nothing when it should |
|---|---|---|
| Keyword search (default) | 5 of 19 | 0 of 12 |
| Semantic search on | 13 of 19 | 6 of 12 |

Those questions were deliberately worded differently from the stored memories, which is the hard
case; on questions that share words with the memory, keyword search finds 9 of 9. Neither mode meets
the target. Semantic search is clearly better on both measures, but on "near-miss" questions (same
project and topic, a detail that was never stored) it still returns the neighbouring memory, so a
returned memory is something for Claude to read, not proof that it answers the question.

`npm run eval` reproduces the keyword numbers on the development set; see `eval/` for the question
sets. The two held-out sets (`eval/heldout.json`, `eval/heldout2.json`) have been used once each and
should not be tuned against.

## Development

```sh
npm ci
npm test              # builds, then runs the core and UI test suites
npm run typecheck
npm run check:network # the core must contain no network code
npm run eval          # retrieval evaluation on the development set
npm run ui:demo       # the UI on a temporary sample database
```

Layout: `src/` is the core (storage, capture hooks, search, MCP server, CLI); `ui/` is a separate
package with the local web server and the Vue app; `eval/` holds the evaluation fixtures; `scripts/`
holds the guards and the semantic-search setup script. Tests never touch your real `~/.engram` or
`~/.claude`; they use temporary folders that are removed when the run ends.

Comments in the code cite design-note numbers (for example `D23`) and spec sections (`§9.4`); those
notes are internal and not part of this repository.
