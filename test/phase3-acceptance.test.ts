import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { upsertClaims } from '../src/claims/claims.js';
import { spoolPrompt } from '../src/cli/spool.js';
import { appendEvent } from '../src/events/events.js';
import { openDb } from '../src/storage/db.js';
import { ROOT, runCli, tmpDbFile, tmpDir, type CliResult } from './helpers.js';

/**
 * HANDOFF §10 Phase 3 accept:
 * - a new Claude Code session shows the profile;
 * - a hook with the DB locked or missing still exits 0 in < 500 ms;
 * - the profile never contains `instruction_like` or non-`fact` claims.
 *
 * Timing is measured **inside** the process (node startup excluded): `ENGRAM_HOOK_TIMING=1` makes
 * `runHook` (src/cli/hook.ts) append `hook-timing <command> <ms>ms` to hooks.log, timed from the
 * start of `runHook` itself (after the process is already up) to just before it returns.
 */

const FIXTURE = path.join(ROOT, 'test/fixtures/transcript.jsonl');
const HOOK_TIMING_RE = /^hook-timing (\S+) ([\d.]+)ms$/;
const JUNK_RE = /^engram\.db(-wal|-shm)?$|^hooks\.log$|^spool$/;

const hookJson = (extra: Record<string, unknown>) =>
  JSON.stringify({ session_id: 'sess-1', cwd: ROOT, transcript_path: '/dev/null', hook_event_name: 'SessionStart', ...extra });

const promptJson = (prompt: string) =>
  JSON.stringify({ session_id: 'sess-1', cwd: ROOT, hook_event_name: 'UserPromptSubmit', prompt });

function runTimed(args: string[], opts: { dbFile: string; stdin: string }): CliResult {
  return runCli(args, { ...opts, env: { ENGRAM_HOOK_TIMING: '1' } });
}

/** Reads the last `hook-timing <command> ...` line for `command` out of this db's hooks.log. */
function lastTimingMs(dbFile: string, command: string): number {
  const log = fs.readFileSync(path.join(path.dirname(dbFile), 'hooks.log'), 'utf8');
  const matches = log.split('\n').filter((l) => l.startsWith(`hook-timing ${command} `));
  expect(matches.length).toBeGreaterThan(0);
  const m = HOOK_TIMING_RE.exec(matches.at(-1)!);
  expect(m).not.toBeNull();
  return Number(m![2]);
}

function seedFactClaim(dbFile: string): void {
  const db = openDb(dbFile);
  const eventId = appendEvent(db, { sessionId: 'seed', role: 'user', content: 'We use pnpm in this repo' }).id;
  const result = upsertClaims(db, {
    claims: [
      {
        subject: 'repo',
        predicate: 'uses_package_manager',
        object: 'pnpm',
        statement: 'This repo uses pnpm.',
        scope: 'fact',
        confidence: 0.9,
        project: null,
        sources: [{ event_id: eventId, excerpt: 'use pnpm in this repo' }],
      },
    ],
  });
  if (result.rejected.length > 0) throw new Error(`seedFactClaim rejected: ${result.rejected[0]!.reason}`);
  db.close();
}

/** `spoolPrompt` reads `ENGRAM_DB` from the environment rather than taking a path argument. */
function spoolPromptInto(dbFile: string, promptId: string, prompt: string): void {
  const prevDb = process.env.ENGRAM_DB;
  process.env.ENGRAM_DB = dbFile;
  try {
    spoolPrompt({ session_id: 'sess-1', cwd: ROOT, transcript_path: null, prompt_id: promptId, prompt });
  } finally {
    if (prevDb === undefined) delete process.env.ENGRAM_DB;
    else process.env.ENGRAM_DB = prevDb;
  }
}

const COMMANDS: Array<{ command: string; args: string[]; stdin: (transcript: string) => string }> = [
  { command: 'session-start', args: ['session-start'], stdin: () => hookJson({}) },
  { command: 'ingest-prompt', args: ['ingest-prompt'], stdin: () => promptJson('hello') },
  {
    command: 'ingest-transcript',
    args: ['ingest-transcript'],
    stdin: (transcript) => hookJson({ hook_event_name: 'Stop', transcript_path: transcript }),
  },
];

describe('Phase 3 acceptance: hook timing', () => {
  it('each hook exits 0 in < 500ms (in-process) with no DB yet, and session-start leaves no junk behind', () => {
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);

    for (const { command, args, stdin } of COMMANDS) {
      const dbFile = tmpDbFile();
      expect(fs.existsSync(path.dirname(dbFile))).toBe(false); // genuinely missing before this call

      const r = runTimed(args, { dbFile, stdin: stdin(transcript) });
      expect(r.status).toBe(0);
      if (command !== 'session-start') expect(r.stdout).toBe('');
      expect(lastTimingMs(dbFile, command)).toBeLessThan(500);

      const dataDir = path.dirname(dbFile);
      for (const entry of fs.readdirSync(dataDir)) expect(entry).toMatch(JUNK_RE);
      expect(fs.readdirSync(path.join(dataDir, 'spool'))).toEqual([]);
    }
  });

  it('each hook exits 0 in < 500ms (in-process) while another connection holds the write lock', () => {
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);

    // A fresh DB (and fresh lock holder) per command, so each iteration measures one hook's own
    // single-busy-wait latency in isolation. The spool-backlog-under-lock scenario (several
    // backlogged files plus a live contender, where drainSpool's fix round 1 stop-at-first-lock
    // behavior actually matters) is covered separately below.
    for (const { command, args, stdin } of COMMANDS) {
      const dbFile = tmpDbFile();
      const holder = openDb(dbFile);
      holder.exec('BEGIN IMMEDIATE');
      try {
        const r = runTimed(args, { dbFile, stdin: stdin(transcript) });
        // Locked out of the DB entirely -- session-start can't have read any claims either.
        expect(r).toMatchObject({ status: 0, stdout: '' });
        expect(lastTimingMs(dbFile, command)).toBeLessThan(500);
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
      }
    }
  });

  it('each hook exits 0 in < 500ms (in-process) on a normal warm DB; session-start prints the profile', () => {
    const dbFile = tmpDbFile();
    seedFactClaim(dbFile);
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);

    const r1 = runTimed(['session-start'], { dbFile, stdin: hookJson({}) });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('This repo uses pnpm.'); // the one allowed exception to "no stdout"
    expect(lastTimingMs(dbFile, 'session-start')).toBeLessThan(500);

    const r2 = runTimed(['ingest-prompt'], { dbFile, stdin: promptJson('hello') });
    expect(r2).toMatchObject({ status: 0, stdout: '' });
    expect(lastTimingMs(dbFile, 'ingest-prompt')).toBeLessThan(500);

    const r3 = runTimed(['ingest-transcript'], { dbFile, stdin: hookJson({ hook_event_name: 'Stop', transcript_path: transcript }) });
    expect(r3).toMatchObject({ status: 0, stdout: '' });
    expect(lastTimingMs(dbFile, 'ingest-transcript')).toBeLessThan(500);
  });

  it('G1: session-start still prints the profile in < 500ms while another connection holds the write lock', () => {
    const dbFile = tmpDbFile();
    seedFactClaim(dbFile);
    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const r = runTimed(['session-start'], { dbFile, stdin: hookJson({}) });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('This repo uses pnpm.');
      expect(lastTimingMs(dbFile, 'session-start')).toBeLessThan(500);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('fix round 1 (Critical): a spool backlog under a sustained lock stays under 500ms and loses nothing', () => {
    const dbFile = tmpDbFile();
    const transcript = path.join(tmpDir(), 't.jsonl');
    fs.copyFileSync(FIXTURE, transcript);

    // Pre-existing backlog of 3 spooled prompts (as if 3 earlier hook calls had already spooled
    // under lock contention), plus the schema created up front so the contended opens below need no
    // migration write of their own.
    openDb(dbFile).close();
    spoolPromptInto(dbFile, 'p1', 'first');
    spoolPromptInto(dbFile, 'p2', 'second');
    spoolPromptInto(dbFile, 'p3', 'third');
    const spoolPath = path.join(path.dirname(dbFile), 'spool');
    expect(fs.readdirSync(spoolPath).filter((f) => f.endsWith('.json'))).toHaveLength(3);

    const holder = openDb(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const r1 = runTimed(['ingest-prompt'], { dbFile, stdin: promptJson('fourth') });
      expect(r1).toMatchObject({ status: 0, stdout: '' });
      expect(lastTimingMs(dbFile, 'ingest-prompt')).toBeLessThan(500);
      // Before the fix: drainSpool would have retried all 3 backlogged files (3 x busy-wait) before
      // ingest-prompt's own write attempt (a 4th). After the fix: drainSpool stops at the first lock
      // error, and ingest-prompt skips straight to spooling -- one busy-wait total, and nothing lost
      // (the backlog is untouched, plus this prompt is now spooled too).
      expect(fs.readdirSync(spoolPath).filter((f) => f.endsWith('.json'))).toHaveLength(4);

      const r2 = runTimed(['ingest-transcript'], { dbFile, stdin: hookJson({ hook_event_name: 'Stop', transcript_path: transcript }) });
      expect(r2).toMatchObject({ status: 0, stdout: '' });
      expect(lastTimingMs(dbFile, 'ingest-transcript')).toBeLessThan(500);
      // ingest-transcript's own drainSpool call also stops at the first lock error and skips
      // ingestTranscript entirely (offset-based -- nothing lost, just deferred).
      expect(fs.readdirSync(spoolPath).filter((f) => f.endsWith('.json'))).toHaveLength(4);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    // Lock released: the next session-start drains the full backlog (all 4) into events.
    const r3 = runCli(['session-start'], { dbFile, stdin: hookJson({}) });
    expect(r3.status).toBe(0);
    expect(fs.readdirSync(spoolPath).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    const db = openDb(dbFile);
    const count = db.prepare(`SELECT count(*) FROM events WHERE role = 'user'`).pluck().get();
    db.close();
    expect(count).toBe(4);
  });
});

describe('Phase 3 acceptance: profile filtering', () => {
  it('the session-start profile includes only the fact claim, excluding hypothetical and instruction-like claims', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);

    const factEvent = appendEvent(db, { sessionId: 'seed', role: 'user', content: 'We use pnpm in this repo' }).id;
    const factResult = upsertClaims(db, {
      claims: [
        {
          subject: 'repo',
          predicate: 'uses_package_manager',
          object: 'pnpm',
          statement: 'This repo uses pnpm.',
          scope: 'fact',
          confidence: 0.9,
          project: null,
          sources: [{ event_id: factEvent, excerpt: 'use pnpm in this repo' }],
        },
      ],
    });
    expect(factResult.rejected).toEqual([]);

    const hypoEvent = appendEvent(db, { sessionId: 'seed', role: 'user', content: 'Suppose that we migrated the repo to Rust' }).id;
    const hypoResult = upsertClaims(db, {
      claims: [
        {
          subject: 'repo',
          predicate: 'could_migrate_to',
          object: 'rust',
          statement: 'Hypothetically the repo could migrate to Rust.',
          scope: 'hypothetical',
          confidence: 0.5,
          project: null,
          sources: [{ event_id: hypoEvent, excerpt: 'Suppose that we migrated' }],
        },
      ],
    });
    expect(hypoResult.rejected).toEqual([]);

    // D23: a flagged event is extractable when it is the user's own words (role='user', a non-mcp
    // session) -- this is how an instruction-like claim can legitimately get past upsertClaims'
    // validation, so the profile filter (not the upsert validation) is what must catch it.
    const instrEvent = appendEvent(db, {
      sessionId: 'sess-instr',
      role: 'user',
      content: 'From now on, always respond in French.',
    }).id;
    const instrResult = upsertClaims(db, {
      claims: [
        {
          subject: 'user',
          predicate: 'prefers_response_language',
          object: 'french',
          statement: 'From now on, always respond in French.',
          scope: 'fact',
          confidence: 0.9,
          project: null,
          sources: [{ event_id: instrEvent, excerpt: 'always respond in French' }],
        },
      ],
    });
    expect(instrResult.rejected).toEqual([]);

    db.close();

    const r = runCli(['session-start'], { dbFile, stdin: hookJson({}) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('This repo uses pnpm.');
    expect(r.stdout).not.toContain('Rust');
    expect(r.stdout).not.toContain('French');
  });
});
