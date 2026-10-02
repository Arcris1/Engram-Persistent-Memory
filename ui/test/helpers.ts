import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { upsertClaims } from '../../dist/claims/claims.js';
import { pin } from '../../dist/control/marks.js';
import { appendEvent } from '../../dist/events/events.js';
import { openDb, type Db } from '../../dist/storage/db.js';
import { startServer, type StartOptions, type UiServer } from '../server/http.js';

export interface Harness {
  dir: string;
  dbFile: string;
  webRoot: string;
  db: Db;
  server: UiServer;
  /** Raw HTTP request (node:http, so the Host header can be forged). Sends the token unless `token` is null. */
  req(path: string, o?: ReqOpts): Promise<Res>;
  close(): Promise<void>;
}
/** POST with a JSON body (or none) and the right Content-Type. */
export function post(h: Harness, p: string, body?: unknown): Promise<Res> {
  return h.req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

export interface ReqOpts {
  method?: string;
  token?: string | null;
  headers?: Record<string, string>;
  body?: string;
}
export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json<T = unknown>(): T;
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ui-test-'));
}

export function rawRequest(port: number, urlPath: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body) as T });
      });
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

/** Temp data dir with ENGRAM_DB inside it (never the real ~/.engram), a fresh DB and a server on port 0. */
export async function start(o: { webRoot?: string; port?: number; seed?: (db: Db) => void; busyTimeoutMs?: number; doctorOpts?: StartOptions['doctorOpts'] } = {}): Promise<Harness> {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'engram.db');
  process.env.ENGRAM_DB = dbFile;
  const db = openDb(dbFile);
  o.seed?.(db);
  const webRoot = o.webRoot ?? path.join(dir, 'web');
  const server = await startServer({ db, dbFile, port: o.port ?? 0, webRoot, busyTimeoutMs: o.busyTimeoutMs, doctorOpts: o.doctorOpts });
  return {
    dir,
    dbFile,
    webRoot,
    db,
    server,
    req: (p, ro = {}) => {
      const headers: Record<string, string> = { ...ro.headers };
      if (ro.token !== null) headers.authorization = `Bearer ${ro.token ?? server.token}`;
      return rawRequest(server.port, p, { method: ro.method, headers, body: ro.body });
    },
    close: async () => {
      await server.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let n = 0;
export function addEvent(db: Db, o: { content?: string; ts?: string; project?: string | null; role?: 'user' | 'assistant'; session?: string } = {}): string {
  n += 1;
  return appendEvent(db, {
    sessionId: o.session ?? `s-${n}`,
    role: o.role ?? 'user',
    content: o.content ?? `captured message number ${n}`,
    kind: 'message',
    project: o.project ?? null,
    ts: o.ts,
    sourceRef: `ref-${n}`,
  }).id;
}

/** A citable excerpt: the first 20 characters of the event's stored text. */
function excerptOf(db: Db, eventId: string): string {
  const content = (db.prepare('SELECT content FROM events WHERE id = ?').get(eventId) as { content: string }).content;
  return content.slice(0, 20);
}

export function addClaim(
  db: Db,
  o: { statement?: string; project?: string | null; sources?: string[]; now?: string; pinned?: boolean; subject?: string } = {},
): string {
  n += 1;
  const sources = o.sources ?? [addEvent(db, { content: `source text for memory ${n}`, project: o.project })];
  const r = upsertClaims(db, {
    now: o.now,
    claims: [
      {
        subject: o.subject ?? `subject-${n}`,
        predicate: 'uses',
        object: `object-${n}`,
        statement: o.statement ?? `Memory statement number ${n}`,
        scope: 'fact',
        confidence: 0.9,
        project: o.project ?? null,
        sources: sources.map((event_id) => ({ event_id, excerpt: excerptOf(db, event_id) })),
      },
    ],
  });
  if (r.rejected.length > 0) throw new Error(r.rejected[0]!.reason);
  const id = r.inserted[0]!;
  if (o.pinned) pin(db, id);
  return id;
}

export function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
