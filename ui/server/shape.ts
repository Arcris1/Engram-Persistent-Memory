// Core rows -> the line types in types.ts. Memory text is untrusted: it is only ever cut and cleaned here, never interpreted.
import { countEmbeddings, loadConfig, stripControlChars, type Db, type ClaimRow, type EventHit, type EventRow } from './core.js';
import type { MemoryLine, MessageLine } from './types.js';

/** Messages in lists are cut to this many characters; the detail view returns them in full. */
export const LIST_TEXT_CHARS = 300;

export interface ClaimExtras {
  pinned: boolean;
  sources: number;
  seq?: number | null;
}

export function memoryLine(c: ClaimRow, x: ClaimExtras): MemoryLine {
  return {
    id: c.id,
    statement: c.statement,
    subject: c.subject,
    predicate: c.predicate,
    object: c.object,
    project: c.project,
    since: c.valid_from ?? c.recorded_at,
    until: c.valid_to,
    status: c.status,
    pinned: x.pinned,
    used: c.access_count,
    sources: x.sources,
    flags: c.flags,
    seq: x.seq ?? null,
  };
}

/** Detail text keeps line breaks and tabs: the core helper's `keepNewline` strips tabs, so they are put back around it. */
function keepTabsAndNewlines(raw: string): string {
  return raw
    .split('\t')
    .map((part) => stripControlChars(part, { keepNewline: true }))
    .join('\t');
}

/** Every run of whitespace/control characters (newlines and tabs included) becomes one space, so lines are never glued. */
function collapseWhitespace(raw: string): string {
  return stripControlChars(raw.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ')).trim();
}

/** Whitespace collapsed (one line), then cut to `max` UTF-16 units without splitting a surrogate pair. */
function cutText(raw: string, max: number, alreadyCut = false): { text: string; cut: boolean } {
  const clean = collapseWhitespace(raw);
  if (clean.length <= max) return { text: clean, cut: alreadyCut };
  const last = clean.charCodeAt(max - 1);
  const at = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return { text: clean.slice(0, at).trimEnd(), cut: true };
}

export function messageLine(e: EventRow, o: { seq?: number | null; full?: boolean } = {}): MessageLine {
  // The detail view keeps line breaks (the text is shown in a wrapping block); lists are one line each.
  const { text, cut } = o.full ? { text: keepTabsAndNewlines(e.content), cut: false } : cutText(e.content, LIST_TEXT_CHARS);
  return { id: e.id, text, cut, role: e.role, kind: e.kind, sessionId: e.session_id, project: e.project, ts: e.ts, flags: e.flags, seq: o.seq ?? null };
}

/** A search hit (its content is already capped by the core at 1000 characters). */
export function messageLineFromHit(h: EventHit): MessageLine {
  const { text, cut } = cutText(h.content, LIST_TEXT_CHARS, h.content_truncated);
  return { id: h.id, text, cut, role: h.role, kind: h.kind, sessionId: h.session_id, project: h.project, ts: h.ts, flags: h.flags, seq: null };
}

/** Whether search by meaning is set up, and how many items have a stored vector (a read; no model is loaded). */
export function semanticStatus(db: Db): { enabled: boolean; embedded: number } {
  const e = loadConfig().embedding;
  return { enabled: e.enabled && e.modelDir !== '' && e.sha256 !== '', embedded: countEmbeddings(db) };
}
