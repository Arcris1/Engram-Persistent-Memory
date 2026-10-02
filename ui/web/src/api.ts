// The ONLY file in the web app that calls fetch: same-origin, relative URLs, bearer token on every request.
import type { ApiError, Detail, ExportDone, ForgetDone, ForgetPreview, Health, MemoriesPage, Overview, PauseState, PinDone } from '../../server/types';

const TOKEN_KEY = 'engram-ui-token';

function readStored(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let memoryToken: string | null = null;

/** Takes a `#token=…` fragment (if any): keeps the token for this tab and always strips the fragment. Returns whether a token was stored. */
export function takeHashToken(): boolean {
  const m = /^#token=([^&]*)/.exec(location.hash);
  if (!m) return false;
  let value: string | null = null;
  try {
    value = decodeURIComponent(m[1]!) || null;
  } catch {
    value = null; // malformed fragment: treated as no token
  }
  if (value) {
    try {
      sessionStorage.setItem(TOKEN_KEY, value);
      memoryToken = null;
    } catch {
      memoryToken = value; // storage is blocked: keep it for this page load only
    }
  }
  history.replaceState(null, '', location.pathname + location.search);
  return value !== null;
}

/** Reads `#token=…` from the URL, keeps it for this tab and removes it from the address bar. */
export function initToken(): boolean {
  takeHashToken();
  return token() !== null;
}

/**
 * Pasting a fresh launch URL into an open tab only fires `hashchange`: reload with the fragment still in place, and the
 * startup `initToken()` reads it, stores it (or keeps it in memory when sessionStorage is unavailable) and strips it.
 */
export function watchTokenHash(reload: () => void = () => location.reload()): () => void {
  const onChange = (): void => {
    if (!location.hash.startsWith('#token=')) return;
    reload(); // a malformed token stores nothing: the reloaded page is disconnected unless an older token is stored
  };
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function token(): string | null {
  return readStored() ?? memoryToken;
}

export class ApiFailure extends Error {
  code: ApiError['error']['code'] | 'network';
  status: number;
  constructor(code: ApiFailure['code'], status: number, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const t = token();
  if (!t) throw new ApiFailure('unauthorized', 401, 'not connected');
  const headers: Record<string, string> = { authorization: `Bearer ${t}` };
  if (method === 'POST') headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  } catch {
    throw new ApiFailure('network', 0, 'could not reach engram');
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const e = (data as Partial<ApiError> | undefined)?.error;
    throw new ApiFailure(e?.code ?? (res.status === 401 ? 'unauthorized' : 'internal'), res.status, e?.message ?? `request failed (${res.status})`);
  }
  return data as T;
}

export interface MemoriesQuery {
  kind: 'memories' | 'messages';
  q?: string;
  /** undefined = all projects, null = no project */
  project?: string | null;
  pinned?: boolean;
  replaced?: boolean;
  flagged?: boolean;
  before?: number;
}

function memoriesPath(q: MemoriesQuery): string {
  const p = new URLSearchParams({ kind: q.kind });
  if (q.q) p.set('q', q.q);
  if (q.project === null) p.set('noProject', '1');
  else if (q.project) p.set('project', q.project);
  if (q.pinned) p.set('pinned', '1');
  if (q.replaced) p.set('replaced', '1');
  if (q.flagged) p.set('flagged', '1');
  if (q.before !== undefined) p.set('before', String(q.before));
  return `/api/memories?${p.toString()}`;
}

const enc = encodeURIComponent;

export const api = {
  overview: (project?: string | null): Promise<Overview> => call('GET', project ? `/api/overview?project=${enc(project)}` : '/api/overview'),
  projects: async (): Promise<string[]> => (await call<{ projects: string[] }>('GET', '/api/projects')).projects,
  memories: (q: MemoriesQuery): Promise<MemoriesPage> => call('GET', memoriesPath(q)),
  detail: (id: string): Promise<Detail> => call('GET', `/api/memories/${enc(id)}`),
  pin: (id: string): Promise<PinDone> => call('POST', `/api/memories/${enc(id)}/pin`),
  unpin: (id: string): Promise<PinDone> => call('POST', `/api/memories/${enc(id)}/unpin`),
  forgetPreview: (id: string): Promise<ForgetPreview> => call('POST', `/api/memories/${enc(id)}/forget`, { confirm: false }),
  forgetConfirm: (id: string, digest: string): Promise<ForgetDone> => call('POST', `/api/memories/${enc(id)}/forget`, { confirm: true, digest }),
  pause: (): Promise<PauseState> => call('POST', '/api/pause'),
  resume: (): Promise<PauseState> => call('POST', '/api/resume'),
  exportAll: (): Promise<ExportDone> => call('POST', '/api/export'),
  health: (): Promise<Health> => call('GET', '/api/health'),
};
