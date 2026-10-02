import { vi } from 'vitest';
import type { Detail, MemoriesPage, MemoryLine, MessageLine, Overview } from '../../server/types';

export function mem(id: string, over: Partial<MemoryLine> = {}): MemoryLine {
  return {
    id, statement: `Statement ${id}`, subject: 'user', predicate: 'prefers', object: 'vitest', project: null, since: '2026-09-28T11:02:00Z', until: null,
    status: 'active', pinned: false, used: 3, sources: 2, flags: [], seq: 10, ...over,
  };
}
export function msg(id: string, over: Partial<MessageLine> = {}): MessageLine {
  return { id, text: `Message ${id}`, cut: false, role: 'user', kind: 'message', sessionId: 'sess-1', project: null, ts: '2026-09-28T11:02:00Z', flags: [], seq: 5, ...over };
}
export function page(items: MemoryLine[] | MessageLine[], kind: 'memories' | 'messages' = 'memories', next: number | null = null): MemoriesPage {
  return { kind, searched: false, items, next };
}
export function memDetail(id: string, over: Partial<Extract<Detail, { kind: 'memory' }>> = {}): Detail {
  return {
    kind: 'memory',
    memory: { ...mem(id), confidence: 0.9, scope: 'user', recordedAt: '2026-09-28T11:02:00Z' },
    sources: [{ message: msg('m1', { text: 'I always use vitest', sessionId: 'sess-9' }), excerpt: 'always use vitest' }],
    replaces: [],
    replacedBy: null,
    ...over,
  };
}
export function msgDetail(id: string, over: Partial<MessageLine> = {}, built: MemoryLine[] = []): Detail {
  return { kind: 'message', message: msg(id, over), built };
}
export function overview(over: Partial<Overview> = {}): Overview {
  return {
    version: '0.1.0', paused: false, project: null,
    stats: { db_path: '/x', db_bytes: 1, schema_version: 3, events: 20, sessions: 3, unconsolidated_sessions: 0, claims: { active: 4, superseded: 1, retracted: 0 }, oldest_event: null, newest_event: null, flagged: { instruction_like: 0, secret_redacted: 0, truncated: 0 } },
    profile: [], activity: [], semantic: { enabled: false, embedded: 0 },
    ...over,
  };
}
export function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
export const apiMock = () => ({
  overview: vi.fn(), projects: vi.fn(), memories: vi.fn(), detail: vi.fn(), pin: vi.fn(), unpin: vi.fn(), forgetPreview: vi.fn(), forgetConfirm: vi.fn(), pause: vi.fn(), resume: vi.fn(), exportAll: vi.fn(), health: vi.fn(),
});
