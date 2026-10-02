import type Database from 'better-sqlite3';

// Schema v1 = HANDOFF §4 with deviations D5 (seq rowid alias), D6 (source_ref), D7 (append-only trigger),
// D8 (porter tokenizer), D19 (claims.superseded_by ON DELETE SET NULL; marks PK (target_id, kind);
// claim_sources(event_id) index -- amended in place per D20, no deployed DB existed), and the Phase 2
// final-review fix wave F6 (sessions.consolidated_seq high-water mark -- amended in place, still no
// deployed DB existed). Never edit a shipped migration after it has reached a real database; append a
// new one instead.
const V1 = `
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  ts            TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  project       TEXT,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  kind          TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','explicit_remember','tool_result','note')),
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  source_ref    TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL DEFAULT 'fact' CHECK (scope IN ('fact','hypothetical','roleplay','draft','quote')),
  flags         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags)),
  UNIQUE (session_id, source_ref, content_hash)
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_session ON events(session_id);
CREATE INDEX events_content_hash ON events(content_hash);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  project          TEXT,
  transcript_path  TEXT,
  ingest_offset    INTEGER NOT NULL DEFAULT 0,
  consolidated_at  TEXT,
  consolidated_seq INTEGER
);

CREATE TABLE claims (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  statement     TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'fact' CHECK (scope IN ('fact','hypothetical','roleplay','draft','quote')),
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from    TEXT,
  valid_to      TEXT,
  recorded_at   TEXT NOT NULL,
  superseded_by TEXT REFERENCES claims(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted')),
  importance    REAL NOT NULL DEFAULT 0.5,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  project       TEXT,
  flags         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags))
);
CREATE INDEX claims_subject ON claims(subject, status);
CREATE INDEX claims_project ON claims(project, status);

CREATE TABLE claim_sources (
  claim_id  TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  excerpt   TEXT,
  PRIMARY KEY (claim_id, event_id)
);
CREATE INDEX claim_sources_event ON claim_sources(event_id);

CREATE TABLE marks (
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('pinned','never_inject','forget_pending')),
  note       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_id, kind)
);

CREATE TABLE accesses (
  id        TEXT PRIMARY KEY,
  ts        TEXT NOT NULL,
  target_id TEXT NOT NULL,
  query     TEXT,
  used      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX accesses_target ON accesses(target_id, ts);

CREATE VIRTUAL TABLE events_fts USING fts5(
  content, content='events', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;

CREATE VIRTUAL TABLE claims_fts USING fts5(
  statement, subject, object, content='claims', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER claims_fts_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, statement, subject, object) VALUES (new.seq, new.statement, new.subject, new.object);
END;
CREATE TRIGGER claims_fts_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, statement, subject, object)
  VALUES ('delete', old.seq, old.statement, old.subject, old.object);
END;
CREATE TRIGGER claims_fts_au AFTER UPDATE OF statement, subject, object ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, statement, subject, object)
  VALUES ('delete', old.seq, old.statement, old.subject, old.object);
  INSERT INTO claims_fts(rowid, statement, subject, object) VALUES (new.seq, new.statement, new.subject, new.object);
END;
`;

// Schema v2 (Phase 4 Task 1, D32): tombstones record a forgotten event's identity (session_id +
// source_ref, or session_id + '' + content_hash for memory_record events) so a transcript rescan
// (ingest-transcript / ingest-prompt) can never resurrect it.
//
// Phase 5 Task 0 (D36): IF NOT EXISTS added. A v2->v1 rollback (README "Rollback") followed by a
// re-upgrade re-runs this exact migration string against a database that already has the table --
// without IF NOT EXISTS that second run throws "table tombstones already exists" and the live
// install can never re-migrate forward. The real ~/.engram/engram.db had never reached v2 at the
// time of this edit (go-live installed at v1; v2 was still pending), so amending this migration
// in place is a one-time exception to "never edit a shipped migration after it has reached a real
// database" -- see DECISIONS.md D36.
const V2 = `
CREATE TABLE IF NOT EXISTS tombstones (
  session_id   TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, source_ref, content_hash)
);
`;

// Schema v3 (Phase 6 Task 2, D42): local vector embeddings for events and claims. The live
// ~/.engram/engram.db is a real schema-v2 database (D36 precedent) -- this migration only adds a new
// table (IF NOT EXISTS, same reasoning as V2) and never rewrites existing event/claim rows. A vector
// is stored as a raw little-endian Float32Array buffer (`vec`, 4*dim bytes) rather than JSON, so
// loadVectors (src/embed/store.ts) can read it back with zero parsing. `content_hash` lets a stale
// vector (source content changed since it was embedded) be detected without re-embedding everything:
// events reuse `events.content_hash`; claims have no such column, so store.ts computes
// sha256(subject + '\n' + statement + '\n' + object) itself. Embeddings are derived, re-derivable data
// (never user input in their own right) -- forget() deletes the rows for whatever it deletes
// (src/control/forget.ts) and export deliberately excludes this table (src/control/export.ts never
// SELECTs from it).
const V3 = `
CREATE TABLE IF NOT EXISTS embeddings (
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('event','claim')),
  target_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS embeddings_model ON embeddings(target_kind, model);
`;

export const MIGRATIONS: readonly string[] = [V1, V2, V3];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${current} is from a newer engram (this build supports v${SCHEMA_VERSION}).`,
    );
  }
  if (current === SCHEMA_VERSION) return;
  // IMMEDIATE takes the write lock up front, so two processes opening a fresh DB can't both migrate.
  db.transaction(() => {
    const from = db.pragma('user_version', { simple: true }) as number;
    for (let v = from; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}
