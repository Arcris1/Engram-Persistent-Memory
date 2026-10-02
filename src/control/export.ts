import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AccessRow } from '../claims/explain.js';
import { rowToClaim, type ClaimRow, type RawClaimRow } from '../claims/claims.js';
import { dataDir } from '../config.js';
import { recomputeImportanceFor } from './importance.js';
import { isInstructionLike } from '../core/detect.js';
import { nowIso } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { rowToEvent, type EventRow, type RawEventRow } from '../events/events.js';
import type { SessionRow } from '../events/sessions.js';
import { SCHEMA_VERSION } from '../storage/schema.js';
import type { Db } from '../storage/db.js';

export const EXPORT_FORMAT = 'engram-export' as const;
export const EXPORT_VERSION = 1 as const;

export interface MarkRow {
  target_id: string;
  kind: string;
  note: string | null;
  created_at: string;
}

export interface ClaimSourceRow {
  claim_id: string;
  event_id: string;
  excerpt: string | null;
}

export interface TombstoneRow {
  session_id: string;
  source_ref: string;
  content_hash: string;
  created_at: string;
}

/**
 * H3: the exported event row's own `seq` at the time of export. Import never uses it for insertion
 * (SQLite assigns a fresh local `seq`) -- it exists solely so import can remap each session's
 * `consolidated_seq` (a high-water mark expressed in `seq` terms, F6/D-reset) from the old database's
 * numbering to the new one's.
 */
export type ExportedEventRow = EventRow & { seq: number };

/**
 * Global Constraints / Task 3: one JSON export file. `tombstones` was added by the Task 1 v2
 * migration -- an older file (schema_version 1) won't have the field at all, which import treats as
 * "nothing to import" for that table, never as an error.
 *
 * D42/Phase 6 Task 2: the v3 `embeddings` table is deliberately NOT a field here and buildExport never
 * SELECTs from it -- every vector is fully re-derivable from the event/claim it embeds (just re-run
 * `engram embed` after an import), so there is nothing to gain from carrying raw vector bytes across
 * installs/model versions and privacy favors leaving them out (same reasoning as forget() erasing
 * them). importData only ever reads the named fields below, so an `embeddings` key present in an
 * old/foreign/hand-crafted file (this or a future export) is silently ignored, never an error.
 */
export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exported_at: string;
  schema_version: number;
  events: ExportedEventRow[];
  sessions: SessionRow[];
  claims: ClaimRow[];
  claim_sources: ClaimSourceRow[];
  marks: MarkRow[];
  accesses: AccessRow[];
  tombstones?: TombstoneRow[];
}

/** Builds the export payload in memory (seq order, so restore order is deterministic). */
export function buildExport(db: Db): ExportFile {
  const rawEvents = db.prepare(`SELECT * FROM events ORDER BY seq`).all() as RawEventRow[];
  const events: ExportedEventRow[] = rawEvents.map((raw) => ({ ...rowToEvent(raw), seq: raw.seq }));
  const sessions = db.prepare(`SELECT * FROM sessions ORDER BY id`).all() as SessionRow[];
  const claims = (db.prepare(`SELECT * FROM claims ORDER BY seq`).all() as RawClaimRow[]).map(rowToClaim);
  const claim_sources = db
    .prepare(`SELECT claim_id, event_id, excerpt FROM claim_sources ORDER BY claim_id, event_id`)
    .all() as ClaimSourceRow[];
  const marks = db.prepare(`SELECT target_id, kind, note, created_at FROM marks ORDER BY target_id, kind`).all() as MarkRow[];
  const accesses = db.prepare(`SELECT * FROM accesses ORDER BY ts`).all() as AccessRow[];
  const tombstones = db
    .prepare(`SELECT session_id, source_ref, content_hash, created_at FROM tombstones ORDER BY session_id, source_ref, content_hash`)
    .all() as TombstoneRow[];

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: nowIso(),
    schema_version: db.pragma('user_version', { simple: true }) as number,
    events,
    sessions,
    claims,
    claim_sources,
    marks,
    accesses,
    tombstones,
  };
}

/** `<dataDir>/engram-export-<timestamp>.json`; colons/dots replaced so it's a valid filename everywhere. */
/**
 * H8: a short random suffix avoids two `engram export` calls in the same millisecond (same ISO
 * timestamp -> same filename) silently overwriting one another -- `writeExport` always writes at
 * mode 0600 regardless, so a collision wouldn't leak anything, but it would still quietly destroy the
 * first export's content.
 */
export function defaultExportPath(): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex');
  return path.join(dataDir(), `engram-export-${stamp}-${suffix}.json`);
}

/** Writes the export JSON to `outPath` (default `defaultExportPath()`) at mode 0600; returns the path. */
export function writeExport(db: Db, outPath?: string): string {
  const file = outPath ?? defaultExportPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(buildExport(db), null, 2)}\n`, { mode: 0o600 });
  // Required, not belt-and-braces: writeFileSync's `mode` option only applies when the file is
  // created. If `file` already exists (e.g. a repeated `--out` path), writeFileSync just overwrites
  // its content and leaves its existing mode bits alone -- so an export re-written over a pre-existing
  // world-readable file would otherwise stay world-readable. chmod explicitly, every time.
  fs.chmodSync(file, 0o600);
  return file;
}

export interface ImportCounts {
  inserted: number;
  skipped: number;
  /** H1: of `skipped`, how many were skipped specifically because they cite forgotten content
   * (a tombstoned event, or a claim citing a never_inject-marked event). */
  skipped_forgotten?: number;
  /** H4: of `skipped`, how many claims were rejected for having zero valid claim_sources in the
   * file (after H1's forgotten-citation skip) -- an import file is untrusted input, and a claim with
   * no real source is exactly the shape a crafted/malicious export would use to smuggle one in.
   * J2: also used for events/claims whose date field(s) (`ts` / `recorded_at`/`valid_from`/
   * `valid_to`) are not a valid ISO date, or are more than a day in the future relative to import
   * time -- see `isValidImportDate` below. */
  skipped_invalid?: number;
}

export interface ImportResult {
  events: ImportCounts;
  sessions: ImportCounts;
  claims: ImportCounts;
  claim_sources: ImportCounts;
  marks: ImportCounts;
  accesses: ImportCounts;
  tombstones: ImportCounts;
}

function runInsert<T>(
  db: Db,
  sql: string,
  rows: T[] | undefined,
  toParams: (row: T) => Record<string, unknown>,
): ImportCounts {
  if (!rows || rows.length === 0) return { inserted: 0, skipped: 0 };
  const stmt = db.prepare(sql);
  let inserted = 0;
  for (const row of rows) {
    const res = stmt.run(toParams(row));
    if (res.changes > 0) inserted++;
  }
  return { inserted, skipped: rows.length - inserted };
}

/**
 * H1: a tombstone means this exact event was deliberately forgotten locally -- importing an older
 * export file (taken before the forget) must not resurrect it. Mirrors appendEvent's own match rule
 * (D32): a real source_ref matches by (session_id, source_ref) alone; the memory_record-style
 * source_ref === '' case falls back to (session_id, '', content_hash).
 */
function isTombstonedLocally(db: Db, event: { session_id: string; source_ref: string; content_hash: string }): boolean {
  const hit =
    event.source_ref !== ''
      ? db.prepare(`SELECT 1 FROM tombstones WHERE session_id = ? AND source_ref = ?`).pluck().get(event.session_id, event.source_ref)
      : db
          .prepare(`SELECT 1 FROM tombstones WHERE session_id = ? AND source_ref = '' AND content_hash = ?`)
          .pluck()
          .get(event.session_id, event.content_hash);
  return Boolean(hit);
}

/** J2: an imported row's date field more than this far in the future relative to import time is
 * untrusted, the same as one that isn't a valid date at all. */
const MAX_FUTURE_SKEW_MS = 86_400_000; // 1 day

/**
 * J2: true if `value` is `null`/`undefined` (allowed for a nullable date field, e.g. `valid_to`) or a
 * valid ISO date no more than `MAX_FUTURE_SKEW_MS` past `nowMs` -- an import file is untrusted input,
 * and a date field is exactly the kind of value a crafted or merely stale/corrupted export could carry
 * (the reviewer's repro: a claim `recorded_at` of `2999-...` that would otherwise sail into the DB and
 * dominate every recency-weighted ranking forever). This governs import acceptance only; §7 scoring's
 * own defenses (score.ts, J2) are a second, independent layer for whatever gets through regardless.
 */
function isValidImportDate(value: string | null | undefined, nowMs: number): boolean {
  if (value === null || value === undefined) return true;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return ms <= nowMs + MAX_FUTURE_SKEW_MS;
}

/**
 * H1/H4/H8: imports events, skipping (and counting as `skipped_forgotten`) any event matched by a
 * local tombstone. A non-tombstoned row is inserted with `INSERT OR IGNORE` on its original id,
 * content unchanged (D34: already processed/redacted at export time, no re-redaction) -- except that
 * H4 re-runs just the `instruction_like` detector over the content and adds the flag if it's missing
 * (an untrusted file's claimed flags can't be trusted, but the content itself must not be rewritten).
 *
 * H8: `INSERT OR IGNORE` can silently no-op not just when the exact `id` already exists, but also when
 * a *different* local row already holds this event's `(session_id, source_ref, content_hash)` UNIQUE
 * triple under a different id (e.g. the same logical event was independently ingested locally after
 * the export was taken). Either way, the returned `idMap` records what the file's event id resolves to
 * locally, looked up by the triple -- never assumed to equal `e.id`.
 *
 * Task 0 (reviewer repro): a crafted file can also declare an event whose `id` collides with a
 * *different* local event (a different `(session_id, source_ref, content_hash)` triple) -- e.g. an
 * attacker reusing a real local id to smuggle a `claim_sources` row onto it. `INSERT OR IGNORE` skips
 * that insert (the id already exists), and the triple lookup then finds no local row either (the
 * attacker's triple doesn't genuinely match anything) -- that id is recorded as explicitly
 * unresolvable (`null`), never silently falling back to treating the file's `e.id` as a trustworthy
 * local id. `idMap` is always populated for every id in the file's `events` array, every time (not
 * just when a local id was found), so `resolveEventId` can tell "never looked at this id" (not in the
 * file at all) apart from "looked, and it does not resolve locally" (`null`).
 */
function importEvents(
  db: Db,
  events: ExportedEventRow[] | undefined,
  nowMs: number,
): { counts: ImportCounts; idMap: Map<string, string | null> } {
  const idMap = new Map<string, string | null>();
  if (!events || events.length === 0) {
    return { counts: { inserted: 0, skipped: 0, skipped_forgotten: 0, skipped_invalid: 0 }, idMap };
  }
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, ts, session_id, project, role, kind, content, content_hash, source_ref, scope, flags)
     VALUES (@id, @ts, @session_id, @project, @role, @kind, @content, @content_hash, @source_ref, @scope, @flags)`,
  );
  const resolveLocalId = db
    .prepare(`SELECT id FROM events WHERE session_id = ? AND source_ref = ? AND content_hash = ?`)
    .pluck();
  let inserted = 0;
  let skipped = 0;
  let skippedForgotten = 0;
  let skippedInvalid = 0;
  for (const e of events) {
    // J2: an invalid/future `ts` is rejected before anything else -- recorded as explicitly
    // unresolvable (null) in idMap, same as the Task 0 id-collision case, so a claim_sources row
    // citing it is never silently trusted as a real local id.
    if (!isValidImportDate(e.ts, nowMs)) {
      skipped++;
      skippedInvalid++;
      idMap.set(e.id, null);
      continue;
    }
    if (isTombstonedLocally(db, e)) {
      skipped++;
      skippedForgotten++;
      continue;
    }
    const flags = [...e.flags];
    if (isInstructionLike(e.content) && !flags.includes('instruction_like')) flags.push('instruction_like');
    const res = stmt.run({ ...e, flags: JSON.stringify(flags) });
    if (res.changes > 0) inserted++;
    else skipped++;
    // Resolve the actual local id for this logical event, whether freshly inserted (same id) or
    // already present under a possibly-different one -- or explicitly unresolvable (null) when the
    // insert was ignored on the id alone and the triple matches nothing local (Task 0 id-collision case).
    const localId = resolveLocalId.get(e.session_id, e.source_ref, e.content_hash) as string | undefined;
    idMap.set(e.id, localId ?? null);
  }
  return { counts: { inserted, skipped, skipped_forgotten: skippedForgotten, skipped_invalid: skippedInvalid }, idMap };
}

/**
 * H8/Task 0: the local event id a file-declared claim_sources `event_id` resolves to. Three outcomes:
 * the id wasn't in the file's own `events` array at all -> trust it as-is (unchanged H8 behavior); it
 * was, and resolved to a local row (possibly remapped) -> that local id; it was, and is explicitly
 * unresolvable (Task 0 id-collision case) -> `null`, which every caller below treats as "does not
 * exist" (a `WHERE id = ?` bound to `null` never matches a `NOT NULL` column).
 */
function resolveEventId(idMap: Map<string, string | null>, fileEventId: string): string | null {
  return idMap.has(fileEventId) ? idMap.get(fileEventId)! : fileEventId;
}

/**
 * H1: a claim that cites an event whose content hash carries a local `never_inject` mark (D32 --
 * i.e. the claim that originally cited it was forgotten here) is rejected wholesale, the same way
 * upsertClaims rejects it at write time -- not just stripped of that one source. The cited event is
 * looked up by its *original* exported id: forgetting a claim never deletes its source events (only
 * forgetting the event itself does, which tombstones it and is handled by importEvents above), so
 * the id is unchanged and resolves locally whether or not this same event was also just imported.
 */
function citesForgottenEvent(db: Db, sources: ClaimSourceRow[], idMap: Map<string, string | null>): boolean {
  return sources.some((s) => {
    const row = db.prepare(`SELECT content_hash FROM events WHERE id = ?`).get(resolveEventId(idMap, s.event_id)) as
      | { content_hash: string }
      | undefined;
    if (!row) return false;
    return Boolean(
      db.prepare(`SELECT 1 FROM marks WHERE target_id = ? AND kind = 'never_inject'`).pluck().get(`hash:${row.content_hash}`),
    );
  });
}

/** H4: an import file is untrusted input (it could be hand-crafted, or restored from someone else's
 * export) -- a claim is only soundly sourced if at least one of its file-declared claim_sources
 * actually resolves to a local event (post H1 skipping). Zero valid sources is exactly the shape a
 * malicious file would use to smuggle in an unsourced "standing instruction" claim. */
function hasValidSource(db: Db, sources: ClaimSourceRow[], idMap: Map<string, string | null>): boolean {
  return sources.some((s) =>
    Boolean(db.prepare(`SELECT 1 FROM events WHERE id = ?`).pluck().get(resolveEventId(idMap, s.event_id))),
  );
}

/** G4 (claims.ts processClaim): a subject is rendered verbatim into the profile; control characters there
 * could forge extra lines/frames. Same check re-run here since an imported subject never went through
 * processClaim's own validation. */
const SUBJECT_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * H1/H4: imports claims. Skips (and counts `skipped_forgotten`) any claim citing a forgotten event;
 * skips (and counts `skipped_invalid`) any claim with zero valid claim_sources in the file; skips
 * (generic `skipped`) a claim whose subject contains control characters. A claim that passes all of
 * that is re-hygiened exactly as a freshly-upserted one would be (re-run redactSecrets over
 * subject/object/statement, re-run isInstructionLike over the redacted text, adding `secret_redacted`/
 * `instruction_like` if the file's own flags are missing them -- an untrusted file's claimed flags
 * can't be trusted either) and always gets the `imported` flag, so `selectProfile` keeps it out of
 * the injected context until the user explicitly pins it (memory_pin strips the flag).
 *
 * Task 0 (reviewer repro): a claim whose `id` collides with an existing local claim reaches the final
 * `INSERT OR IGNORE` (it can have perfectly valid-looking sources -- the attack is the id collision
 * itself, not an invalid source), which silently no-ops. That no-op case is added to `skippedClaimIds`
 * too, not just the three checks above -- otherwise `importClaimSources` below has no way to know this
 * claim's id already belongs to an existing local claim, and would happily insert the file's
 * claim_sources rows onto it (source-injection into an existing claim via a crafted id collision).
 *
 * J2: a claim whose `recorded_at`/`valid_from`/`valid_to` isn't a valid ISO date, or is more than a
 * day in the future relative to import time, is also rejected (`skipped_invalid`) -- the reviewer's
 * repro was a claim exported (or crafted) with `recorded_at: '2999-...'`. The file's `importance`/
 * `access_count`/`last_accessed` are never trusted either way (even for an otherwise-valid claim): the
 * insert below pins them to safe defaults regardless of what the file says, and `importData` recomputes
 * real `importance` afterward via `recomputeImportanceFor` once this claim's sources/accesses are in
 * place -- usage signals (`used`, `access_count`) aren't trustworthy from an external file, so they're
 * never used to seed either the counter or the formula.
 */
function importClaims(
  db: Db,
  claims: ClaimRow[] | undefined,
  claimSourcesByClaim: Map<string, ClaimSourceRow[]>,
  idMap: Map<string, string | null>,
  nowMs: number,
): { counts: ImportCounts; skippedClaimIds: Set<string>; insertedIds: string[] } {
  const skippedClaimIds = new Set<string>();
  const insertedIds: string[] = [];
  if (!claims || claims.length === 0) {
    return { counts: { inserted: 0, skipped: 0, skipped_forgotten: 0, skipped_invalid: 0 }, skippedClaimIds, insertedIds };
  }
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO claims
       (id, subject, predicate, object, statement, scope, confidence, valid_from, valid_to, recorded_at,
        superseded_by, status, importance, access_count, last_accessed, project, flags)
     VALUES (@id, @subject, @predicate, @object, @statement, @scope, @confidence, @valid_from, @valid_to,
             @recorded_at, @superseded_by, @status, @importance, @access_count, @last_accessed, @project, @flags)`,
  );
  let inserted = 0;
  let skipped = 0;
  let skippedForgotten = 0;
  let skippedInvalid = 0;
  for (const c of claims) {
    if (
      !isValidImportDate(c.recorded_at, nowMs) ||
      !isValidImportDate(c.valid_from, nowMs) ||
      !isValidImportDate(c.valid_to, nowMs)
    ) {
      skipped++;
      skippedInvalid++;
      skippedClaimIds.add(c.id);
      continue;
    }
    const sources = claimSourcesByClaim.get(c.id) ?? [];
    if (citesForgottenEvent(db, sources, idMap)) {
      skipped++;
      skippedForgotten++;
      skippedClaimIds.add(c.id);
      continue;
    }
    if (!hasValidSource(db, sources, idMap)) {
      skipped++;
      skippedInvalid++;
      skippedClaimIds.add(c.id);
      continue;
    }
    if (SUBJECT_CONTROL_CHARS_RE.test(c.subject)) {
      skipped++;
      skippedClaimIds.add(c.id);
      continue;
    }

    const redSubject = redactSecrets(c.subject);
    const redObject = redactSecrets(c.object);
    const redStatement = redactSecrets(c.statement);
    const flags = new Set(c.flags);
    if (redSubject.types.length > 0 || redObject.types.length > 0 || redStatement.types.length > 0) {
      flags.add('secret_redacted');
    }
    if (isInstructionLike(`${redSubject.text}\n${redStatement.text}\n${redObject.text}`)) flags.add('instruction_like');
    flags.add('imported');

    const res = stmt.run({
      ...c,
      subject: redSubject.text,
      object: redObject.text,
      statement: redStatement.text,
      flags: JSON.stringify([...flags]),
      // J2: the file's importance/access_count/last_accessed are untrusted usage signals -- ignored
      // on insert regardless of what the file claims. `importData` recomputes real `importance` via
      // `recomputeImportanceFor` once this claim's sources (and, for accesses, used=0 rows) are in
      // place; access_count/last_accessed simply start fresh, same as the schema default for a brand
      // new claim (this counter is already known to diverge from the real `accesses` rows after a
      // merge import -- see the global scoring constraints -- so there's no sound value to carry over).
      importance: 0,
      access_count: 0,
      last_accessed: null,
    });
    if (res.changes > 0) {
      inserted++;
      insertedIds.push(c.id);
    } else {
      // Task 0: ignored on the id itself (already exists locally) -- never treat this as a claim
      // whose claim_sources are still fair game to import.
      skipped++;
      skippedClaimIds.add(c.id);
    }
  }
  return {
    counts: { inserted, skipped, skipped_forgotten: skippedForgotten, skipped_invalid: skippedInvalid },
    skippedClaimIds,
    insertedIds,
  };
}

/**
 * H4: a `pinned` mark is a local user decision, not restorable state -- importing one from a file
 * (someone else's export, or a crafted one) would otherwise let an attacker pin an unsourced claim
 * straight into the always-surfaced profile. Pinned marks are dropped outright (not imported, not
 * even counted as skipped-and-retryable -- simply never inserted). Every other mark kind imports with
 * `note` forced to NULL, since a note is free-form text that was never validated as safe to inject.
 */
function importMarks(db: Db, marks: MarkRow[] | undefined): ImportCounts {
  if (!marks || marks.length === 0) return { inserted: 0, skipped: 0 };
  const stmt = db.prepare(`INSERT OR IGNORE INTO marks (target_id, kind, note, created_at) VALUES (?, ?, ?, ?)`);
  let inserted = 0;
  let skipped = 0;
  for (const m of marks) {
    if (m.kind === 'pinned') {
      skipped++;
      continue;
    }
    const res = stmt.run(m.target_id, m.kind, null, m.created_at);
    if (res.changes > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

/**
 * H3: inserts sessions, returning which ids were newly inserted (as opposed to already present
 * locally -- a merge, whose row is left untouched per `INSERT OR IGNORE` semantics). `importData`
 * needs this set to know which sessions' `consolidated_seq` it's allowed to remap below.
 */
function importSessions(db: Db, sessions: SessionRow[] | undefined): { counts: ImportCounts; insertedIds: Set<string> } {
  const insertedIds = new Set<string>();
  if (!sessions || sessions.length === 0) return { counts: { inserted: 0, skipped: 0 }, insertedIds };
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO sessions
       (id, started_at, ended_at, project, transcript_path, ingest_offset, consolidated_at, consolidated_seq)
     VALUES (@id, @started_at, @ended_at, @project, @transcript_path, @ingest_offset, @consolidated_at, @consolidated_seq)`,
  );
  let inserted = 0;
  let skipped = 0;
  for (const s of sessions) {
    const res = stmt.run(s);
    if (res.changes > 0) {
      inserted++;
      insertedIds.add(s.id);
    } else {
      skipped++;
    }
  }
  return { counts: { inserted, skipped }, insertedIds };
}

/**
 * H3: a session's `consolidated_seq` is a high-water mark expressed in the *source* database's `seq`
 * numbering (F6) -- importing it verbatim is wrong once the restore gives its events a different
 * local `seq` (e.g. a forget before the export left a gap, so the restored events pack down). For
 * each newly-inserted session with a non-null `consolidated_seq`, remap it to the max *local* `seq`
 * among that session's imported events whose *old* (exported) `seq` was <= the old consolidated_seq
 * -- null if none resolve locally (e.g. every one of them was skipped as forgotten). A session that
 * already existed locally (a merge) is left untouched entirely, per `INSERT OR IGNORE` semantics.
 */
function remapConsolidatedSeq(db: Db, sessions: SessionRow[] | undefined, events: ExportedEventRow[] | undefined, insertedSessionIds: Set<string>): void {
  const bySession = new Map<string, ExportedEventRow[]>();
  for (const e of events ?? []) {
    const list = bySession.get(e.session_id);
    if (list) list.push(e);
    else bySession.set(e.session_id, [e]);
  }
  const seqOf = db.prepare(`SELECT seq FROM events WHERE id = ?`).pluck();
  const update = db.prepare(`UPDATE sessions SET consolidated_seq = ? WHERE id = ?`);

  for (const s of sessions ?? []) {
    if (!insertedSessionIds.has(s.id)) continue;
    if (s.consolidated_seq === null || s.consolidated_seq === undefined) continue;
    let maxNewSeq: number | null = null;
    for (const e of bySession.get(s.id) ?? []) {
      // An export file written before H3 has no `seq` on its events at all; there's no sound way to
      // map its old consolidated_seq into this database's numbering, so such an event simply doesn't
      // count toward the remap (fails safe toward re-review -- see maxNewSeq's null fallback below --
      // rather than toward silently importing a consolidated_seq number that means nothing locally).
      if (typeof e.seq !== 'number') continue;
      if (e.seq > s.consolidated_seq) continue;
      const newSeq = seqOf.get(e.id) as number | undefined;
      if (newSeq !== undefined && (maxNewSeq === null || newSeq > maxNewSeq)) maxNewSeq = newSeq;
    }
    update.run(maxNewSeq, s.id);
  }
}

/**
 * H1/H8: skips claim_sources rows whose claim was skipped, or whose event doesn't exist locally (its
 * own import having been skipped, e.g. as a tombstoned event). H8: `event_id` is resolved through
 * `idMap` first -- when the cited event row was silently deduplicated onto a *different* local id by
 * `INSERT OR IGNORE`'s UNIQUE(session_id, source_ref, content_hash) constraint, inserting the claim
 * source under the file's original (now non-existent locally) id would otherwise violate the events
 * foreign key at commit and abort the whole import; resolving first means it never does.
 */
function importClaimSources(
  db: Db,
  rows: ClaimSourceRow[] | undefined,
  skippedClaimIds: Set<string>,
  idMap: Map<string, string | null>,
): ImportCounts {
  if (!rows || rows.length === 0) return { inserted: 0, skipped: 0 };
  const stmt = db.prepare(`INSERT OR IGNORE INTO claim_sources (claim_id, event_id, excerpt) VALUES (?, ?, ?)`);
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    if (skippedClaimIds.has(row.claim_id)) {
      skipped++;
      continue;
    }
    const eventId = resolveEventId(idMap, row.event_id);
    // Task 0: eventId is null for an explicitly-unresolvable file event id (id-collision case) --
    // `WHERE id = ?` bound to null matches nothing, so this falls through to the same skip as any
    // other nonexistent event, never attaching to an unrelated local row that happens to share the id.
    const eventExists = eventId !== null && db.prepare(`SELECT 1 FROM events WHERE id = ?`).pluck().get(eventId);
    if (!eventExists) {
      skipped++;
      continue;
    }
    const res = stmt.run(row.claim_id, eventId, row.excerpt);
    if (res.changes > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

/**
 * Task 0/J2: an `accesses` row's `target_id` is a free-form id (no FK) logged by search/pin. J2
 * narrows what an untrusted file's row is allowed to attach to: only a claim this *same import*
 * actually just inserted (`insertedClaimIds`, from `importClaims`'s return) -- not any claim that
 * merely happens to exist locally already. Without this, a crafted or stale export could graft a
 * fabricated `used=1` access (inflating activation/importance) onto someone else's real, pre-existing
 * claim just by guessing or reusing its id; restricting to this file's own freshly-inserted claims
 * means an attacker can only ever inflate a claim their own file also had to legitimately supply and
 * get past every other import check. `used` is always forced to 0 on import regardless of the file's
 * own value -- usage signals aren't trustworthy from an external file (same reasoning as J2's
 * importance-recompute-after-import below). `query` is always nulled on every imported row too: a
 * search query is free-form text that can itself contain content the user has since forgotten, and
 * was never validated as safe to import (same reasoning as marks' `note`, H4).
 */
function importAccesses(db: Db, rows: AccessRow[] | undefined, insertedClaimIds: ReadonlySet<string>): ImportCounts {
  if (!rows || rows.length === 0) return { inserted: 0, skipped: 0 };
  const stmt = db.prepare(`INSERT OR IGNORE INTO accesses (id, ts, target_id, query, used) VALUES (?, ?, ?, NULL, 0)`);
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!insertedClaimIds.has(r.target_id)) {
      skipped++;
      continue;
    }
    const res = stmt.run(r.id, r.ts, r.target_id);
    if (res.changes > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

/**
 * Global Constraints / Task 3: additive by primary key for every table, never overwrites an existing
 * row (`INSERT OR IGNORE`). Events and claims are inserted directly with their original `id`,
 * `content`/`statement` etc. -- never through `appendEvent`/`upsertClaims`, which would re-run
 * redaction/dedupe/tombstone checks that don't apply to a restore. `seq` is never supplied; SQLite
 * assigns it, and the FTS triggers (which fire on every INSERT regardless of how it's issued) keep
 * `events_fts`/`claims_fts` in sync automatically.
 *
 * `defer_foreign_keys` is turned on for the whole transaction so insert order doesn't matter -- e.g. a
 * claim whose `superseded_by` points at a claim inserted later in the same batch, or a `claim_sources`
 * row inserted before (or after) its claim/event rows, all resolve correctly once every row is in and
 * the transaction commits.
 *
 * J2: `now` is injectable (same convention as everywhere else scoring/importance is computed, e.g.
 * `upsertClaims`), defaulting to the real wall clock -- it governs both the "more than a day in the
 * future" date-validity check (`isValidImportDate`) and the `recomputeImportanceFor` call at the end,
 * which normalizes every freshly-imported claim's `importance` onto the §7 formula from local state
 * (never from the file's own, untrusted `importance` field) now that its sources/accesses are in place.
 */
export function importData(db: Db, data: ExportFile, now: string = nowIso()): ImportResult {
  if (data?.format !== EXPORT_FORMAT) {
    throw new Error(`not an engram export file (expected format '${EXPORT_FORMAT}', got '${String((data as { format?: unknown })?.format)}')`);
  }
  if (data.version !== EXPORT_VERSION) {
    throw new Error(`unsupported export version ${String(data.version)} (this engram reads version ${EXPORT_VERSION})`);
  }
  if (typeof data.schema_version !== 'number') {
    throw new Error('export file is missing schema_version');
  }
  if (data.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `export file schema v${data.schema_version} is from a newer engram (this build supports v${SCHEMA_VERSION})`,
    );
  }
  const nowMs = new Date(now).getTime();

  return db
    .transaction((): ImportResult => {
      db.pragma('defer_foreign_keys = ON');

      const { counts: sessions, insertedIds: insertedSessionIds } = importSessions(db, data.sessions);

      const { counts: events, idMap: eventIdMap } = importEvents(db, data.events, nowMs);

      // H3: must run after events are inserted (it queries each event's now-current local seq).
      remapConsolidatedSeq(db, data.sessions, data.events, insertedSessionIds);

      const claimSourcesByClaim = new Map<string, ClaimSourceRow[]>();
      for (const row of data.claim_sources ?? []) {
        const list = claimSourcesByClaim.get(row.claim_id);
        if (list) list.push(row);
        else claimSourcesByClaim.set(row.claim_id, [row]);
      }
      const { counts: claims, skippedClaimIds, insertedIds: insertedClaimIds } = importClaims(
        db, data.claims, claimSourcesByClaim, eventIdMap, nowMs,
      );

      const claim_sources = importClaimSources(db, data.claim_sources, skippedClaimIds, eventIdMap);

      // J2: recomputed after claim_sources (so a newly-cited explicit_remember source is seen) but
      // before accesses (whose own usage signals are untrusted and forced to used=0 below regardless,
      // so running before or after accesses makes no difference to the result -- this ordering is
      // simply the earliest point every input recomputeImportanceFor reads is already in place).
      recomputeImportanceFor(db, insertedClaimIds, now);

      const marks = importMarks(db, data.marks);

      // J2: only accesses rows targeting a claim THIS import just inserted are restored -- see
      // importAccesses's doc comment.
      const accesses = importAccesses(db, data.accesses, new Set(insertedClaimIds));

      const tombstones = runInsert(
        db,
        `INSERT OR IGNORE INTO tombstones (session_id, source_ref, content_hash, created_at)
         VALUES (@session_id, @source_ref, @content_hash, @created_at)`,
        data.tombstones,
        (r) => ({ ...r }),
      );

      return { events, sessions, claims, claim_sources, marks, accesses, tombstones };
    })
    .immediate();
}
