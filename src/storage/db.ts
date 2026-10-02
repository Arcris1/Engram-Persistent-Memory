import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

export type Db = Database.Database;

export interface OpenDbOptions {
  /** How long a write waits for a competing writer before SQLITE_BUSY. Hooks use a short value. */
  busyTimeoutMs?: number;
}

export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  // D9: the -wal/-shm files are created lazily by SQLite, so the umask must stay set for the process.
  process.umask(0o077);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(file, { timeout: opts.busyTimeoutMs ?? 5000 });
  fs.chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // D31: forget() must physically erase data, not just unlink it -- secure_delete makes SQLite
  // overwrite deleted content with zeros instead of leaving it as recoverable free-page bytes.
  db.pragma('secure_delete = ON');
  migrate(db);
  return db;
}
