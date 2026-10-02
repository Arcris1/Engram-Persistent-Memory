import http from 'node:http';
import type { Duplex } from 'node:stream';
import { HttpError, type Ctx, type Route } from './context.js';
import type { Db, doctorReport } from './core.js';
import { healthRoutes } from './routes-health.js';
import { readRoutes } from './routes-read.js';
import { writeRoutes } from './routes-write.js';
import { hostOk, newToken, originOk, SECURITY_HEADERS, tokenOk } from './security.js';
import { resolveStatic } from './static.js';
import type { ApiError } from './types.js';

export interface UiServer {
  port: number;
  token: string;
  /** The launch URL, token in the fragment: `http://127.0.0.1:<port>/#token=<token>`. */
  url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  db: Db;
  dbFile: string;
  /** First port to try (default 47800, 0 = any free port); when taken, the next 10 are tried. */
  port?: number;
  token?: string;
  webRoot: string;
  now?: () => Date;
  /** SQLite busy timeout for the server's connection, in ms (tests set a short one to provoke 503). */
  busyTimeoutMs?: number;
  /** Options for `doctorReport()` behind /api/health (tests inject a temp claude dir and `noMcp`). */
  doctorOpts?: Parameters<typeof doctorReport>[0];
}

const MAX_BODY_BYTES = 64 * 1024;

/** Reads a JSON object body (at most 64 KB; empty = `{}`); anything else is an HttpError. */
function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(new HttpError(415, 'bad_request', 'send Content-Type: application/json'));
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) return Promise.reject(tooLarge(req, res));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        reject(tooLarge(req, res));
      } else chunks.push(c);
    });
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'bad request')));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        const v: unknown = JSON.parse(text);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch {
        reject(new HttpError(400, 'bad_request', 'the body must be a JSON object'));
      }
    });
  });
}

/** Answers are sent with the connection closed so an oversized upload is not read to the end. */
function tooLarge(req: http.IncomingMessage, res: http.ServerResponse): HttpError {
  res.setHeader('Connection', 'close');
  res.on('finish', () => req.socket.destroy());
  return new HttpError(413, 'bad_request', 'the request body is too large');
}

const DEFAULT_PORT = 47800;
const PORT_SPAN = 10;
const MAX_PORT = 65535;

/**
 * Conservative parser limits for a server that only ever talks to one local browser: a request
 * head is a few hundred bytes, so 16 KB of headers is generous; a client that has not finished its
 * head in 15 s or its whole request in 30 s is stuck or hostile.
 */
export const LIMITS = { maxHeaderSize: 16 * 1024, headersTimeout: 15_000, requestTimeout: 30_000 } as const;

/** Node-level parser errors (431, bad method, malformed head) never reach `onRequest`: answer them here, with no detail. */
function onClientError(err: Error & { code?: string }, socket: Duplex): void {
  if (!socket.writable) return void socket.destroy();
  const status = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  const reason = status === 431 ? 'Request Header Fields Too Large' : 'Bad Request';
  const head = [`HTTP/1.1 ${status} ${reason}`, ...Object.entries(SECURITY_HEADERS).map(([k, v]) => `${k}: ${v}`), 'Content-Length: 0', 'Connection: close', '', ''];
  socket.end(head.join('\r\n'));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, code: ApiError['error']['code'], message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } } satisfies ApiError, extra);
}

/** Maps a thrown value to a response; only the error's type and code are ever written to stderr, never its text. */
function sendFailure(res: http.ServerResponse, err: unknown): void {
  if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof Error && (err.message.startsWith('no claim or event with id') || err.message.startsWith('no claim with id'))) return sendError(res, 404, 'not_found', 'no claim or event with that id');
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return sendError(res, 503, 'busy', 'engram is busy writing; try again');
  process.stderr.write(`engram-ui: internal error (${err instanceof Error ? err.name : typeof err}${typeof code === 'string' ? ` ${code}` : ''})\n`);
  sendError(res, 500, 'internal', 'something went wrong');
}

function sendStatic(req: http.IncomingMessage, res: http.ServerResponse, webRoot: string, pathname: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('method not allowed');
  }
  const r = resolveStatic(webRoot, pathname);
  res.writeHead(r.status, { 'Content-Type': r.type, 'Content-Length': Buffer.byteLength(r.body) });
  res.end(req.method === 'HEAD' ? undefined : r.body);
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function startServer(o: StartOptions): Promise<UiServer> {
  const token = o.token ?? newToken();
  const now = o.now ?? (() => new Date());
  const routes: Route[] = [...readRoutes(), ...writeRoutes(), ...healthRoutes()];
  if (o.busyTimeoutMs !== undefined) o.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(o.busyTimeoutMs))}`);
  let boundPort = 0;

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void handle(req, res);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (!hostOk(req.headers.host, boundPort) || !originOk(req.headers.origin, boundPort)) {
        return sendError(res, 403, 'forbidden', 'this address is not allowed');
      }
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      } catch {
        return sendError(res, 400, 'bad_request', 'bad request');
      }
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return sendStatic(req, res, o.webRoot, url.pathname);

      if (!tokenOk(req.headers.authorization, token)) return sendError(res, 401, 'unauthorized', 'missing or wrong token');
      const matching = routes.filter((r) => r.match.test(url.pathname));
      if (matching.length === 0) return sendError(res, 404, 'not_found', 'no such endpoint');
      const route = matching.find((r) => r.method === req.method);
      if (!route) return sendError(res, 405, 'bad_request', 'method not allowed', { Allow: [...new Set(matching.map((r) => r.method))].join(', ') });
      const body = route.method === 'POST' ? await readJsonBody(req, res) : {};
      const ctx: Ctx = { db: o.db, dbFile: o.dbFile, now, url, body, doctorOpts: o.doctorOpts };
      sendJson(res, 200, await route.handle(ctx, url.pathname.match(route.match)!));
    } catch (err) {
      sendFailure(res, err);
    }
  };

  // A taken port moves on to the next one; any other listen error is real.
  const base = o.port ?? DEFAULT_PORT;
  // Never past 65535 (listen() would throw a RangeError instead of moving on).
  const tries = base === 0 ? 1 : Math.min(PORT_SPAN + 1, MAX_PORT - base + 1);
  let server: http.Server | undefined;
  for (let i = 0; i < tries && !server; i++) {
    const candidate = http.createServer({ maxHeaderSize: LIMITS.maxHeaderSize, requireHostHeader: false }, onRequest);
    // requireHostHeader: false lets a Host-less request reach onRequest, which answers 403 with the security headers.
    candidate.headersTimeout = LIMITS.headersTimeout;
    candidate.requestTimeout = LIMITS.requestTimeout;
    candidate.on('clientError', onClientError);
    try {
      await listen(candidate, base === 0 ? 0 : base + i);
      server = candidate;
    } catch (err) {
      candidate.close();
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
    }
  }
  if (!server) throw new Error(`no free port in ${base}-${Math.min(base + PORT_SPAN, MAX_PORT)}; stop the other engram UI or pass --port`);
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('engram-ui: server has no TCP address');
  boundPort = addr.port;
  const bound = server;
  return {
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}/#token=${token}`,
    close: () =>
      new Promise((resolve) => {
        bound.close(() => resolve());
        bound.closeAllConnections();
      }),
  };
}
