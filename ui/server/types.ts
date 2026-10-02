// THE CONTRACT between the UI server and the web app. The web app imports this file type-only.
import type { Stats } from './core.js';

export type { Stats };

export interface MemoryLine {
  id: string;
  statement: string;
  subject: string;
  predicate: string;
  object: string;
  project: string | null;
  /** valid_from, else recorded_at */
  since: string;
  /** valid_to */
  until: string | null;
  status: 'active' | 'superseded' | 'retracted';
  pinned: boolean;
  /** access_count: how often Claude has been shown this memory */
  used: number;
  /** number of cited source messages */
  sources: number;
  flags: string[];
  /** paging cursor; null where the line did not come from a listing */
  seq: number | null;
}

export interface MessageLine {
  id: string;
  text: string;
  /** true when `text` was cut to the list limit */
  cut: boolean;
  role: string;
  kind: string;
  sessionId: string;
  project: string | null;
  ts: string;
  flags: string[];
  seq: number | null;
}

export interface Overview {
  version: string;
  paused: boolean;
  project: string | null;
  stats: Stats;
  profile: MemoryLine[];
  activity: { day: string; count: number }[];
  semantic: { enabled: boolean; embedded: number };
}

export interface MemoriesPage {
  kind: 'memories' | 'messages';
  searched: boolean;
  items: MemoryLine[] | MessageLine[];
  next: number | null;
}

export type Detail =
  | {
      kind: 'memory';
      memory: MemoryLine & { confidence: number; scope: string; recordedAt: string };
      sources: { message: MessageLine; excerpt: string | null }[];
      replaces: MemoryLine[];
      replacedBy: MemoryLine | null;
    }
  | { kind: 'message'; message: MessageLine; built: MemoryLine[] }; // detail message text is full (cut: false)

export interface ApiError {
  error: {
    code: 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'paused' | 'changed' | 'busy' | 'internal';
    message: string;
  };
}

export interface ForgetPreview {
  /** Fingerprint of what the forget would remove; a confirm must send it back unchanged. */
  digest: string;
  kind: 'memory' | 'message';
  erases: { memories: MemoryLine[]; messages: MessageLine[] };
  stays: { memories: MemoryLine[]; messages: MessageLine[] };
  notes: string[];
}

export interface ForgetDone {
  forgotten: true;
  erased: { memories: number; messages: number };
}

export interface PinDone {
  id: string;
  pinned: boolean;
}

export interface PauseState {
  paused: boolean;
}

export interface ExportDone {
  path: string;
}

export interface Health {
  version: string;
  paused: boolean;
  stats: Stats;
  hooks: { event: string; label: string; ok: boolean; problem: string | null }[];
  /** Captured messages waiting in the spool to be saved. */
  waiting: number;
  /** `checked` false: Claude Code was not asked (skipped) or did not answer; `detail` is then a plain reason, or empty. */
  memoryTools: { checked: boolean; ok: boolean; detail: string };
  search: { semantic: boolean; embedded: number };
  hookErrors: { last24h: number };
  storage: { path: string; bytes: number; ownerOnly: boolean; newestBackup: string | null; schema: number };
}
