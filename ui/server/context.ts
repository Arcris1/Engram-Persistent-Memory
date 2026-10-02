// Shared by http.ts and the route modules (kept apart so neither imports the other).
import type { Db, doctorReport } from './core.js';
import type { ApiError } from './types.js';

export interface Ctx {
  db: Db;
  dbFile: string;
  now: () => Date;
  url: URL;
  /** Parsed JSON body of a POST (`{}` when empty). */
  body: unknown;
  /** Options for `doctorReport()` (tests inject a temp claude dir and `noMcp`). */
  doctorOpts?: Parameters<typeof doctorReport>[0];
}

export interface Route {
  method: 'GET' | 'POST';
  match: RegExp;
  handle(ctx: Ctx, m: RegExpMatchArray): unknown | Promise<unknown>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError['error']['code'],
    message: string,
  ) {
    super(message);
  }
}
