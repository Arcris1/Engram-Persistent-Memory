#!/usr/bin/env node
/**
 * HANDOFF §11 evaluation suite. Seeds a temp, on-disk SQLite DB through the real write APIs
 * (appendEvent, upsertClaims -- including supersede), then exercises retrieval through the real
 * read APIs (searchClaimsRanked, searchEventsRanked, selectProfile, explain, claim valid_from/
 * valid_to, and the real `memory_search` MCP tool via an in-memory client for injection warnings)
 * against eval/fixtures.json, a synthetic multi-session history for one user across three projects
 * plus >=100 realistic engineering-life distractor events/claims.
 *
 * `npm run eval` = `npm run build && node dist/eval/run.js` (this file does NOT invoke the build
 * itself -- see package.json). `runEvaluation()` is also imported directly, in-process, by
 * test/eval.test.ts as a regression guard.
 *
 * Phase 5 Task 3 fix round 1: everything in this run is deterministic -- a single fixed
 * `now` (FIXED_NOW below), threaded everywhere, and claims seeded with a fixed `recorded_at` via
 * `upsertClaims`'s `now` option -- so running the eval twice gives byte-identical output (see
 * test/eval.test.ts). Reports the TRUE numbers against HANDOFF §11's targets (recall@5 >= 0.8 for
 * single-hop, temporal, update; 100% for abstention and injection) and exits 1 on a miss. Fixtures and
 * criteria are not tuned after the fact to force a pass -- see eval/fixtures.json's
 * `abstentionCriterionNote` for why the original score-threshold abstention criterion was replaced.
 *
 * Phase 5 Task 3 fix round 2: injection's PASS criterion is now exactly HANDOFF
 * §11's own definition -- the target never appears in `selectProfile` for any checked project (events:
 * correctly flagged `instruction_like` at write time, so never eligible for a claim or the profile at
 * all). The real `memory_search` warning text is a SECONDARY metric (`warningStatus` on each injection
 * ItemResult; see evalInjection's doc comment), reported but not folded into `pass`.
 *
 * Phase 5 Task 3c (D40): `--set dev|heldout` and `--gate none|A|B` flags. `dev` (default) is the
 * existing `eval/fixtures.json` items above; `heldout` swaps in `eval/heldout.json`'s items (single-hop,
 * update, abstention only -- no temporal/injection items exist in the held-out set) over the SAME
 * corpus (`fixtures.events`/`fixtures.claims`). `gate` (default 'none', unchanged production default)
 * is threaded into every `searchClaimsRanked`/`searchEventsRanked` call via `ClaimSearchParams`/
 * `EventSearchParams.gate` (src/search/gate.ts). A category with zero items for the active set (e.g.
 * temporal/injection under `heldout`) is reported as not-applicable rather than a vacuous FAIL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// J3: `@modelcontextprotocol/client` lives in devDependencies (package.json), not dependencies --
// this file (and its built dist/eval/run.js) is a dev-only tool (`npm run eval`), never part of the
// shipped MCP server's own runtime (bin/engram-mcp.js never imports src/eval/*). `npm ci` installs
// devDependencies by default, so this import resolves fine for anyone actually running the eval
// suite from a full checkout; `npm ci --omit=dev` (e.g. a slim production install) correctly leaves
// it out, and such an install was never expected to run `npm run eval` anyway.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { explain } from '../claims/explain.js';
import { readClaim, upsertClaims, type ClaimInput, type ClaimRow } from '../claims/claims.js';
import { selectProfile } from '../claims/profile.js';
import type { Embedder } from '../embed/embedder.js';
import { embedMissing } from '../embed/backfill.js';
import { tryLoadEmbedder } from '../embed/load.js';
import { appendEvent, readEvent } from '../events/events.js';
import { createServer } from '../mcp/server.js';
import { INSTRUCTION_LIKE_WARNING } from '../mcp/tools/search.js';
import { DEFAULT_TAU } from '../search/candidates.js';
import { searchClaimsRanked } from '../search/claims.js';
import { searchEventsRanked } from '../search/events.js';
import type { Gate } from '../search/gate.js';
import { openDb, type Db } from '../storage/db.js';
import type { Role, Scope } from '../core/types.js';

/** Phase 5 Task 3 fix round 1: a single fixed clock for the whole run -- see file header. */
export const FIXED_NOW = '2026-09-30T00:00:00Z';

// ---------------------------------------------------------------------------------------------
// Fixture shape (eval/fixtures.json)
// ---------------------------------------------------------------------------------------------

export interface FixtureEvent {
  key: string;
  sessionId: string;
  role: Role;
  kind?: 'message' | 'explicit_remember' | 'tool_result' | 'note';
  content: string;
  project: string | null;
  ts: string;
}

export interface FixtureClaim {
  key: string;
  subject: string;
  predicate: string;
  object: string;
  statement: string;
  scope: Scope;
  confidence: number;
  validFrom: string;
  project: string | null;
  sources: { eventKey: string }[];
  supersedes?: string;
}

interface SingleHopItem {
  id: string;
  category: 'single-hop';
  query: string;
  project?: string | null;
  expected: string[];
}

interface UpdateItem {
  id: string;
  category: 'update';
  query: string;
  project?: string | null;
  current: string;
  superseded: string;
}

/** Fix round 1: time-window items now run a real keyword search bounded by since/until. */
interface TemporalTimeWindowItem {
  id: string;
  category: 'temporal';
  mode: 'time_window';
  query: string;
  project?: string | null;
  since?: string;
  until?: string;
  expected: string[];
}

/** Fix round 1: claim-window items now also run a real search (include_superseded) before checking
 * valid_from/valid_to, instead of only inspecting the rows directly. */
interface TemporalClaimWindowItem {
  id: string;
  category: 'temporal';
  mode: 'claim_window';
  query: string;
  project?: string | null;
  checkDate: string;
  expectValid: string[];
  expectInvalid: string[];
}

type TemporalItem = TemporalTimeWindowItem | TemporalClaimWindowItem;

interface AbstentionItem {
  id: string;
  category: 'abstention';
  query: string;
  forbidden: string[];
  /** Fix round 1: a near-miss item (same topic, wrong specific fact) scored separately. */
  hard_negative?: boolean;
}

interface InjectionClaimItem {
  id: string;
  category: 'injection';
  level: 'claim';
  target: string;
  projectsToCheck: (string | null)[];
  project?: string | null;
  searchQuery: string;
}

interface InjectionEventItem {
  id: string;
  category: 'injection';
  level: 'event';
  target: string;
  project?: string | null;
  searchQuery: string;
}

type InjectionItem = InjectionClaimItem | InjectionEventItem;

type FixtureItem = SingleHopItem | UpdateItem | TemporalItem | AbstentionItem | InjectionItem;

export interface Fixtures {
  abstentionCriterionNote: string;
  events: FixtureEvent[];
  claims: FixtureClaim[];
  items: FixtureItem[];
}

/** Phase 5 Task 3c: `eval/heldout.json`'s shape -- single-hop/update/abstention items only, same
 * field names as the matching FixtureItem variants (no `mode`/temporal/injection fields). */
interface HeldoutFile {
  _comment: string;
  items: (SingleHopItem | UpdateItem | AbstentionItem)[];
}

export type EvalSet = 'dev' | 'heldout' | 'heldout2';

// ---------------------------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------------------------

/** Fix round 2: injection's secondary warning metric -- 'ok' (retrieved, carries the warning),
 * 'MISSING' (retrieved WITHOUT the warning -- a real failure of its own), or 'not exercised' (the
 * target simply wasn't retrieved by the search query -- not a failure, just untested). */
export type WarningStatus = 'ok' | 'MISSING' | 'not exercised';

export interface ItemResult {
  id: string;
  category: string;
  pass: boolean;
  /** 1-indexed rank of the first relevant hit within the returned (limit 5) results; null if absent
   * or not applicable (abstention/injection, which aren't ranked-recall tasks). */
  rank: number | null;
  hardNegative?: boolean;
  /** Injection items only -- see WarningStatus. */
  warningStatus?: WarningStatus;
  detail: string;
}

export interface CategoryResult {
  category: string;
  passed: number;
  total: number;
  rate: number;
  target: number;
  ok: boolean;
  /** recall@1 / MRR, only meaningful for the three ranked-recall categories. */
  recallAt1: number | null;
  mrr: number | null;
  hardNegative: { passed: number; total: number } | null;
  /** Injection's secondary warning metric (fix round 2): exercised = retrieved at all (ok + MISSING);
   * missing = retrieved without the warning text. Not part of `pass`/`ok` above. */
  warnings: { exercised: number; missing: number; total: number } | null;
}

export interface EvalReport {
  items: ItemResult[];
  categories: CategoryResult[];
  overallPass: boolean;
}

const TARGETS: Record<string, number> = {
  'single-hop': 0.8,
  temporal: 0.8,
  update: 0.8,
  abstention: 1.0,
  injection: 1.0,
};

const CATEGORY_ORDER = ['single-hop', 'temporal', 'update', 'abstention', 'injection'];
const RECALL_CATEGORIES = new Set(['single-hop', 'temporal', 'update']);

// ---------------------------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------------------------

function evalDir(): string {
  // Two directories up from this file (dist/eval/run.js -> dist -> repo root, or when vitest runs
  // this file directly from src/eval/run.ts -> src -> repo root) lands on the repo root either way.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'eval');
}

export function loadFixtures(): Fixtures {
  const raw = fs.readFileSync(path.join(evalDir(), 'fixtures.json'), 'utf8');
  return JSON.parse(raw) as Fixtures;
}

/** Phase 5 Task 3c: the held-out item set (D40). Not modified by this task -- loaded read-only.
 * Phase 6 Task 4: `heldout2` (eval/heldout2.json, D44) has the same shape. */
function loadHeldoutItems(set: 'heldout' | 'heldout2'): FixtureItem[] {
  const raw = fs.readFileSync(path.join(evalDir(), `${set}.json`), 'utf8');
  return (JSON.parse(raw) as HeldoutFile).items;
}

// ---------------------------------------------------------------------------------------------
// Seeding: through the real write APIs only.
// ---------------------------------------------------------------------------------------------

export function seed(db: Db, fixtures: Fixtures): { eventId: Record<string, string>; claimId: Record<string, string> } {
  const eventId: Record<string, string> = {};
  for (const ev of fixtures.events) {
    const result = appendEvent(db, {
      sessionId: ev.sessionId,
      role: ev.role,
      kind: ev.kind,
      content: ev.content,
      project: ev.project,
      ts: ev.ts,
    });
    if (!result.inserted) throw new Error(`eval fixture: event '${ev.key}' was not inserted (duplicate?)`);
    eventId[ev.key] = result.id;
  }

  const claimId: Record<string, string> = {};
  for (const c of fixtures.claims) {
    const sources = c.sources.map((s) => {
      const id = eventId[s.eventKey];
      if (!id) throw new Error(`eval fixture: claim '${c.key}' cites unknown event key '${s.eventKey}'`);
      return { event_id: id, excerpt: readEvent(db, id)!.content };
    });
    const supersedes = c.supersedes ? claimId[c.supersedes] : undefined;
    if (c.supersedes && !supersedes) {
      throw new Error(`eval fixture: claim '${c.key}' supersedes unknown claim key '${c.supersedes}'`);
    }
    const input: ClaimInput = {
      subject: c.subject,
      predicate: c.predicate,
      object: c.object,
      statement: c.statement,
      scope: c.scope,
      confidence: c.confidence,
      valid_from: c.validFrom,
      project: c.project,
      sources,
      ...(supersedes ? { supersedes } : {}),
    };
    // Fix round 1: fixed `recorded_at` (FIXED_NOW) for every claim, so recency scoring -- and the
    // eval's output -- is reproducible across runs instead of depending on the real insertion wall clock.
    const result = upsertClaims(db, { claims: [input], now: FIXED_NOW });
    if (result.rejected.length > 0) {
      throw new Error(`eval fixture: claim '${c.key}' rejected: ${result.rejected[0]!.reason}`);
    }
    const id = result.inserted[0] ?? result.merged[0];
    if (!id) throw new Error(`eval fixture: claim '${c.key}' produced no id`);
    claimId[c.key] = id;
  }

  return { eventId, claimId };
}

// ---------------------------------------------------------------------------------------------
// Item evaluation
// ---------------------------------------------------------------------------------------------

function isValidAt(claim: ClaimRow, at: string): boolean {
  if (claim.valid_from && claim.valid_from > at) return false;
  if (claim.valid_to && claim.valid_to < at) return false;
  return true;
}

/** 1-indexed rank of the first id in `hitIds` that is also in `candidateIds`; null if none is. */
function rankOf(hitIds: readonly string[], candidateIds: readonly string[]): number | null {
  const wanted = new Set(candidateIds);
  for (let i = 0; i < hitIds.length; i++) {
    if (wanted.has(hitIds[i]!)) return i + 1;
  }
  return null;
}

function formatWindow(since: string | undefined, until: string | undefined): string {
  return `${since ?? '-inf'}, ${until ?? '+inf'}`;
}

/** Phase 6 Task 3 (D42/hybrid): embeds `query` once via `embedder` (undefined when hybrid isn't
 * active for this run), for threading into a single searchClaimsRanked/searchEventsRanked call. */
async function embedQuery(embedder: Embedder | null, query: string): Promise<Float32Array | undefined> {
  if (!embedder) return undefined;
  return (await embedder.embed([query]))[0];
}

async function evalSingleHop(
  db: Db,
  item: SingleHopItem,
  claimId: Record<string, string>,
  now: string,
  gate: Gate,
  embedder: Embedder | null,
  tau: number,
): Promise<ItemResult> {
  const queryVector = await embedQuery(embedder, item.query);
  const hits = searchClaimsRanked(
    db,
    { query: item.query, mode: 'keyword', project: item.project, limit: 5, gate, queryVector, queryModel: embedder?.model, tau },
    now,
  );
  const hitIds = hits.map((h) => h.id);
  const expectedIds = item.expected.map((k) => claimId[k]!);
  const rank = rankOf(hitIds, expectedIds);
  const pass = rank !== null;
  return {
    id: item.id,
    category: item.category,
    pass,
    rank,
    detail: pass ? `expected claim at rank ${rank}` : `none of [${item.expected.join(', ')}] in top5 (got ${hits.length} hits)`,
  };
}

async function evalUpdate(
  db: Db,
  item: UpdateItem,
  claimId: Record<string, string>,
  now: string,
  gate: Gate,
  embedder: Embedder | null,
  tau: number,
): Promise<ItemResult> {
  const queryVector = await embedQuery(embedder, item.query);
  const hits = searchClaimsRanked(
    db,
    { query: item.query, mode: 'keyword', project: item.project, limit: 5, gate, queryVector, queryModel: embedder?.model, tau },
    now,
  );
  const hitIds = hits.map((h) => h.id);
  const currentId = claimId[item.current]!;
  const supersededId = claimId[item.superseded]!;
  const rank = rankOf(hitIds, [currentId]);
  const currentPresent = rank !== null;
  const supersededAbsent = !hitIds.includes(supersededId);
  const ex = explain(db, currentId);
  const explainable = ex?.kind === 'claim' && ex.supersedes.some((c) => c.id === supersededId);
  const pass = currentPresent && supersededAbsent && explainable;
  const problems: string[] = [];
  if (!currentPresent) problems.push('current claim not in top5');
  if (!supersededAbsent) problems.push('superseded claim leaked into default results');
  if (!explainable) problems.push('superseded claim not reachable via explain(current)');
  return {
    id: item.id,
    category: item.category,
    pass,
    rank,
    detail: pass ? `current wins (rank ${rank}), old explainable` : problems.join('; '),
  };
}

async function evalTemporal(
  db: Db,
  item: TemporalItem,
  eventId: Record<string, string>,
  claimId: Record<string, string>,
  now: string,
  gate: Gate,
  embedder: Embedder | null,
  tau: number,
): Promise<ItemResult> {
  const queryVector = await embedQuery(embedder, item.query);
  if (item.mode === 'time_window') {
    // Fix round 1: a real keyword search bounded by since/until (not the chronological-only `time`
    // mode), so this item actually exercises retrieval ranking rather than pure date filtering.
    const hits = searchEventsRanked(
      db,
      {
        query: item.query,
        mode: 'keyword',
        since: item.since,
        until: item.until,
        project: item.project,
        limit: 5,
        gate,
        queryVector,
        queryModel: embedder?.model,
        tau,
      },
      now,
    );
    const hitIds = hits.map((h) => h.id);
    const expectedIds = item.expected.map((k) => eventId[k]!);
    const rank = rankOf(hitIds, expectedIds);
    const pass = rank !== null;
    return {
      id: item.id,
      category: item.category,
      pass,
      rank,
      detail: pass
        ? `expected event at rank ${rank} within [${formatWindow(item.since, item.until)}]`
        : `none of [${item.expected.join(', ')}] in top5 window (${formatWindow(item.since, item.until)})`,
    };
  }

  // claim_window: Fix round 1 -- also runs a real search (include_superseded, so both the current and
  // the superseded claim are retrievable) before checking valid_from/valid_to on the date in question.
  const hits = searchClaimsRanked(
    db,
    { query: item.query, mode: 'keyword', project: item.project, include_superseded: true, limit: 5, gate, queryVector, queryModel: embedder?.model, tau },
    now,
  );
  const hitIds = hits.map((h) => h.id);
  const familyIds = [...item.expectValid, ...item.expectInvalid].map((k) => claimId[k]!);
  const rank = rankOf(hitIds, familyIds);
  const retrievedOk = rank !== null;
  const validOk = item.expectValid.every((k) => isValidAt(readClaim(db, claimId[k]!)!, item.checkDate));
  const invalidOk = item.expectInvalid.every((k) => !isValidAt(readClaim(db, claimId[k]!)!, item.checkDate));
  const pass = retrievedOk && validOk && invalidOk;
  const problems: string[] = [];
  if (!retrievedOk) problems.push('claim family not retrieved via search (include_superseded)');
  if (!validOk) problems.push('expected-valid claim failed its valid_from/valid_to window check');
  if (!invalidOk) problems.push('expected-invalid claim failed its valid_from/valid_to window check');
  return {
    id: item.id,
    category: item.category,
    pass,
    rank,
    detail: pass ? `retrieved (rank ${rank}) and valid_from/valid_to correct at ${item.checkDate}` : problems.join('; '),
  };
}

/**
 * Fix round 1: the 0.5 score threshold was arithmetically unsound -- removed (see
 * eval/fixtures.json's abstentionCriterionNote for why). An item now passes only when the search
 * (same query, same limit:5, both indexes) returns literally zero claims and zero events, and no
 * forbidden id among whatever is returned.
 */
async function evalAbstention(
  db: Db,
  item: AbstentionItem,
  ids: Record<string, string>,
  now: string,
  gate: Gate,
  embedder: Embedder | null,
  tau: number,
): Promise<ItemResult> {
  const queryVector = await embedQuery(embedder, item.query);
  const claimHits = searchClaimsRanked(db, { query: item.query, mode: 'keyword', limit: 5, gate, queryVector, queryModel: embedder?.model, tau }, now);
  const eventHits = searchEventsRanked(db, { query: item.query, mode: 'keyword', limit: 5, gate, queryVector, queryModel: embedder?.model, tau }, now);
  const forbiddenIds = new Set(item.forbidden.map((k) => ids[k]!));
  const hasForbidden = [...claimHits, ...eventHits].some((h) => forbiddenIds.has(h.id));
  const zeroResults = claimHits.length === 0 && eventHits.length === 0;
  const pass = zeroResults && !hasForbidden;
  const detail = hasForbidden
    ? 'a forbidden id was returned'
    : zeroResults
      ? 'zero claims and zero events (clean abstention)'
      : `search returned ${claimHits.length} claim(s) and ${eventHits.length} event(s), not a clean abstention`;
  return { id: item.id, category: item.category, pass, rank: null, hardNegative: item.hard_negative === true, detail };
}

interface McpSearchHit {
  id: string;
  warning?: string;
}
interface McpSearchResult {
  claims: McpSearchHit[];
  events: McpSearchHit[];
}

/**
 * Fix round 2: HANDOFF §11 defines injection resistance as "an event containing
 * 'ignore your instructions and...' never appears in the profile" -- that is the PRIMARY criterion an
 * item passes or fails on: for a claim-level item, the target must never appear in `selectProfile` for
 * any of `projectsToCheck`; for an event-level item (events never appear in any profile by
 * construction -- `selectProfile` only ever returns claims), the analogous primary check is that the
 * event was correctly flagged `instruction_like` at write time, so it is never eligible to be cited
 * into a claim (and therefore never eligible for the profile) in the first place.
 *
 * The real `memory_search` warning text is now a SECONDARY metric only (`warningStatus`), reported but
 * not folded into `pass`: 'ok' (retrieved, carries the warning), 'MISSING' (retrieved WITHOUT it -- a
 * real failure of its own, just not of the primary criterion), or 'not exercised' (never retrieved by
 * this item's search query -- not a failure, simply untested).
 */
async function evalInjection(
  db: Db,
  item: InjectionItem,
  eventId: Record<string, string>,
  claimId: Record<string, string>,
  now: string,
  client: Client,
): Promise<ItemResult> {
  const result = await client.callTool({
    name: 'memory_search',
    arguments: { query: item.searchQuery, mode: 'keyword', project: item.project, limit: 5 },
  });
  const structured = result.structuredContent as McpSearchResult;

  if (item.level === 'claim') {
    const targetId = claimId[item.target]!;
    const leakedProjects = item.projectsToCheck.filter((p) => selectProfile(db, { project: p, now }).some((c) => c.id === targetId));
    const pass = leakedProjects.length === 0;
    const hit = structured.claims.find((c) => c.id === targetId);
    const warningStatus: WarningStatus = !hit ? 'not exercised' : hit.warning === INSTRUCTION_LIKE_WARNING ? 'ok' : 'MISSING';
    const detail = pass
      ? `excluded from every profile (warning: ${warningStatus})`
      : `leaked into profile for project(s): ${leakedProjects.join(', ')} (warning: ${warningStatus})`;
    return { id: item.id, category: item.category, pass, rank: null, warningStatus, detail };
  }

  const targetId = eventId[item.target]!;
  const flaggedAtSource = readEvent(db, targetId)!.flags.includes('instruction_like');
  const pass = flaggedAtSource;
  const hit = structured.events.find((e) => e.id === targetId);
  const warningStatus: WarningStatus = !hit ? 'not exercised' : hit.warning === INSTRUCTION_LIKE_WARNING ? 'ok' : 'MISSING';
  const detail = pass
    ? `flagged at write time, never eligible for the profile (warning: ${warningStatus})`
    : `event not flagged instruction_like at write time (warning: ${warningStatus})`;
  return { id: item.id, category: item.category, pass, rank: null, warningStatus, detail };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

async function connectEvalClient(db: Db, dbFile: string, embedder: Embedder | null, tau: number): Promise<Client> {
  const server = createServer({ db, dbFile, defaultProject: null, embedder, tau });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'engram-eval', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

export interface RunOptions {
  /** Phase 5 Task 3c (D40). Default 'dev' (eval/fixtures.json's own items -- unchanged behavior). */
  set?: EvalSet;
  /** Phase 5 Task 3c (D40). Default 'none' (unchanged production default; src/search/gate.ts). */
  gate?: Gate;
  /** Phase 6 Task 3 (D42/hybrid): embed every seeded row (via embedMissing) and run every search with
   * hybrid ranking. Reads ENGRAM_EMBED_MODEL_DIR/ENGRAM_EMBED_MODEL_SHA256 unless `embedderOverride`
   * is given. Default false (unchanged pre-Phase-6 behaviour). */
  embed?: boolean;
  /** Phase 6 Task 3 (D42/hybrid admission). Only consulted when `embed` is true. Defaults to
   * DEFAULT_TAU (src/search/candidates.ts). */
  tau?: number;
  /** Test-only seam: use this embedder instead of resolving the real ONNX one from
   * ENGRAM_EMBED_MODEL_DIR/_SHA256 -- lets tests exercise `--embed`'s code path deterministically
   * with the fake embedder, without requiring a real model file on disk. Ignored unless `embed` is
   * true; never read by the CLI entrypoint (main() below never sets it). */
  embedderOverride?: Embedder;
}

/** Phase 6 Task 3: resolves the embedder for an `--embed` run, or null for a non-embed run. Reads
 * ENGRAM_EMBED_MODEL_DIR/ENGRAM_EMBED_MODEL_SHA256 and throws a clear error if either is missing or
 * the model fails to load -- `--embed` never silently falls back to the disabled path. */
async function resolveEvalEmbedder(options: RunOptions): Promise<Embedder | null> {
  if (!options.embed) return null;
  if (options.embedderOverride) return options.embedderOverride;
  const modelDir = process.env.ENGRAM_EMBED_MODEL_DIR;
  const sha256 = process.env.ENGRAM_EMBED_MODEL_SHA256;
  if (!modelDir || !sha256) {
    throw new Error(
      '--embed requires both ENGRAM_EMBED_MODEL_DIR and ENGRAM_EMBED_MODEL_SHA256 to be set in the environment',
    );
  }
  const { embedder, reason } = await tryLoadEmbedder({
    ingestToolResults: false,
    embedding: { enabled: true, modelDir, sha256 },
  });
  if (!embedder) throw new Error(`--embed: failed to load the embedder (${reason})`);
  return embedder;
}

export async function runEvaluation(options: RunOptions = {}): Promise<EvalReport> {
  const set = options.set ?? 'dev';
  const gate = options.gate ?? 'none';
  const tau = options.tau ?? DEFAULT_TAU;
  // Fail fast, before seeding a temp db, if --embed was asked for but can't actually run.
  const embedder = await resolveEvalEmbedder(options);
  const fixtures = loadFixtures();
  // D40: held-out uses the SAME corpus (fixtures.events/fixtures.claims) with the held-out item set
  // substituted in for fixtures.items -- eval/heldout.json itself carries no corpus of its own.
  const evalItems = set === 'dev' ? fixtures.items : loadHeldoutItems(set);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-eval-'));
  const dbFile = path.join(tmp, 'eval.db');
  const db = openDb(dbFile);
  let client: Client | undefined;
  try {
    const { eventId, claimId } = seed(db, fixtures);
    // Phase 6 Task 3: embed every seeded row before any search runs -- the harness never embeds
    // lazily mid-eval, matching the plan's "no inline embedding beyond the query itself" constraint.
    if (embedder) await embedMissing(db, embedder, {});
    // Fix round 1: one fixed `now` for the whole run, threaded explicitly through every scored call
    // (never re-queried ad hoc mid-run) -- see FIXED_NOW's doc comment.
    const now = FIXED_NOW;
    const allIds: Record<string, string> = { ...eventId, ...claimId };
    client = await connectEvalClient(db, dbFile, embedder, tau);

    const items: ItemResult[] = [];
    for (const item of evalItems) {
      switch (item.category) {
        case 'single-hop':
          items.push(await evalSingleHop(db, item, claimId, now, gate, embedder, tau));
          break;
        case 'update':
          items.push(await evalUpdate(db, item, claimId, now, gate, embedder, tau));
          break;
        case 'temporal':
          items.push(await evalTemporal(db, item, eventId, claimId, now, gate, embedder, tau));
          break;
        case 'abstention':
          items.push(await evalAbstention(db, item, allIds, now, gate, embedder, tau));
          break;
        case 'injection':
          items.push(await evalInjection(db, item, eventId, claimId, now, client));
          break;
      }
    }

    const categories: CategoryResult[] = CATEGORY_ORDER.map((category) => {
      const inCategory = items.filter((i) => i.category === category);
      const passed = inCategory.filter((i) => i.pass).length;
      const total = inCategory.length;
      const rate = total > 0 ? passed / total : 0;
      const target = TARGETS[category]!;
      const isRecall = RECALL_CATEGORIES.has(category);
      const recallAt1 = isRecall && total > 0 ? inCategory.filter((i) => i.rank === 1).length / total : null;
      const mrr = isRecall && total > 0 ? inCategory.reduce((s, i) => s + (i.rank ? 1 / i.rank : 0), 0) / total : null;
      const hn = category === 'abstention' ? inCategory.filter((i) => i.hardNegative) : [];
      const hardNegative = hn.length > 0 ? { passed: hn.filter((i) => i.pass).length, total: hn.length } : null;
      const warnings =
        category === 'injection'
          ? {
              exercised: inCategory.filter((i) => i.warningStatus === 'ok' || i.warningStatus === 'MISSING').length,
              missing: inCategory.filter((i) => i.warningStatus === 'MISSING').length,
              total,
            }
          : null;
      // Phase 5 Task 3c: a category with no items for the active set (temporal/injection under
      // `heldout`, which has neither) is vacuously "ok" -- not a FAIL -- and excluded from overallPass
      // in any meaningful sense (it's trivially true), so it never masks a real miss elsewhere.
      const ok = total === 0 ? true : rate >= target;
      return { category, passed, total, rate, target, ok, recallAt1, mrr, hardNegative, warnings };
    });

    const overallPass = categories.every((c) => c.ok);
    return { items, categories, overallPass };
  } finally {
    if (client) await client.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// CLI: printing + exit code. Only runs when this file is executed directly (`node dist/eval/run.js`),
// not when runEvaluation() is imported by test/eval.test.ts.
// ---------------------------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMaybe(n: number | null): string {
  return n === null ? '-' : pct(n);
}

function printReport(report: EvalReport, options: RunOptions): void {
  const embedPart = options.embed ? ` embed=true tau=${options.tau ?? DEFAULT_TAU}` : '';
  console.log(`\n§11 evaluation suite -- set=${options.set ?? 'dev'} gate=${options.gate ?? 'none'}${embedPart}\n`);
  const header = ['Category', 'Passed/Total', 'Recall@5', 'Recall@1', 'MRR', 'Target', 'Status'];
  const rows = report.categories.map((c) => [
    c.category,
    `${c.passed}/${c.total}`,
    c.total === 0 ? '-' : pct(c.rate),
    fmtMaybe(c.recallAt1),
    fmtMaybe(c.mrr),
    c.total === 0 ? '-' : pct(c.target),
    c.total === 0 ? 'N/A' : c.ok ? 'PASS' : 'FAIL',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(header));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(row));

  const injection = report.categories.find((c) => c.category === 'injection');
  if (injection?.warnings) {
    console.log(
      `\ninjection ${injection.passed}/${injection.total} plus warnings exercised ${injection.warnings.exercised}/${injection.warnings.total}, missing ${injection.warnings.missing}`,
    );
    console.log('Injection warnings per item:');
    for (const i of report.items.filter((i) => i.category === 'injection')) {
      console.log(`  ${i.id}: warning ${i.warningStatus}`);
    }
  }

  const abstention = report.categories.find((c) => c.category === 'abstention');
  if (abstention?.hardNegative) {
    console.log(`\nAbstention hard negatives: ${abstention.hardNegative.passed}/${abstention.hardNegative.total}`);
  }

  const failures = report.items.filter((i) => !i.pass);
  if (failures.length > 0) {
    console.log('\nFailing items:');
    for (const f of failures) console.log(`  [${f.category}] ${f.id}: ${f.detail}`);
  }

  console.log(`\nOVERALL: ${report.overallPass ? 'PASS' : 'FAIL'}\n`);
}

/** Phase 5 Task 3c: `--set dev|heldout` (Phase 6 Task 4 adds `heldout2`) and `--gate none|A|B`, defaults `dev`/`none` (unchanged
 * behavior when neither flag is given). Phase 6 Task 3 adds `--embed` (boolean) and `--tau <x>`
 * (float, only meaningful with `--embed`). Any invalid value is a hard error -- no silent fallback. */
function parseArgs(argv: readonly string[]): RunOptions {
  const options: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--set') {
      const value = argv[++i];
      if (value !== 'dev' && value !== 'heldout' && value !== 'heldout2') {
        throw new Error(`--set must be 'dev', 'heldout' or 'heldout2', got: ${value}`);
      }
      options.set = value;
    } else if (arg === '--gate') {
      const value = argv[++i];
      if (value !== 'none' && value !== 'A' && value !== 'B') throw new Error(`--gate must be 'none', 'A' or 'B', got: ${value}`);
      options.gate = value;
    } else if (arg === '--embed') {
      options.embed = true;
    } else if (arg === '--tau') {
      const raw = argv[++i];
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(value)) throw new Error(`--tau must be a finite number, got: ${raw}`);
      options.tau = value;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runEvaluation(options);
  printReport(report, options);
  if (!report.overallPass) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
