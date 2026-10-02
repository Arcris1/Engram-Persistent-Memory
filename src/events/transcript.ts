import fs from 'node:fs';
import type { Db } from '../storage/db.js';
import { appendEvent } from './events.js';
import { ensureSession, setIngestOffset } from './sessions.js';

export interface TranscriptItem {
  uuid: string;
  ts: string;
  role: 'assistant' | 'tool';
  kind: 'message' | 'tool_result';
  text: string;
}

export interface ParseOptions {
  ingestToolResults: boolean;
}

interface Block {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

interface Entry {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

const blocks = (content: unknown): Block[] =>
  Array.isArray(content) ? content.filter((b): b is Block => typeof b === 'object' && b !== null) : [];

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n');
}

/** D12: one JSON object per line; keep assistant text (and optionally tool results); skip everything else. */
export function parseTranscriptLines(chunk: string, opts: ParseOptions): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null || entry.isSidechain === true) continue;
    if (typeof entry.uuid !== 'string' || !entry.uuid) continue;
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : '';
    const content = entry.message?.content;

    if (entry.type === 'assistant') {
      const text = textOfBlocks(content);
      if (text.trim()) items.push({ uuid: entry.uuid, ts, role: 'assistant', kind: 'message', text });
    } else if (entry.type === 'user' && opts.ingestToolResults) {
      const text = blocks(content)
        .filter((b) => b.type === 'tool_result')
        .map((b) => textOfBlocks(b.content))
        .filter((t) => t.trim())
        .join('\n\n');
      if (text.trim()) items.push({ uuid: entry.uuid, ts, role: 'tool', kind: 'tool_result', text });
    }
  }
  return items;
}

export interface IngestTranscriptInput {
  sessionId: string;
  transcriptPath: string;
  project?: string | null;
  ingestToolResults?: boolean;
}

export interface IngestTranscriptResult {
  inserted: number;
  duplicates: number;
  offset: number;
}

export function ingestTranscript(db: Db, input: IngestTranscriptInput): IngestTranscriptResult {
  const session = ensureSession(db, {
    id: input.sessionId,
    project: input.project ?? null,
    transcriptPath: input.transcriptPath,
  });
  const fd = fs.openSync(input.transcriptPath, 'r');
  let start: number;
  let chunk: Buffer;
  try {
    const size = fs.fstatSync(fd).size;
    // A file smaller than our offset was replaced or truncated: rescan; dedupe on source_ref prevents duplicates.
    start = session.ingest_offset > size ? 0 : session.ingest_offset;
    // D27: our offset only means "right after a complete line" if that's genuinely where the
    // previous ingest stopped. If the byte just before it isn't a newline, this file was replaced
    // (e.g. a compact rewrote transcript_path) even though it's the same size or larger: rescan
    // from 0 rather than read from a stale, misaligned offset. Dedupe absorbs any repeats.
    if (start > 0) {
      const prevByte = Buffer.alloc(1);
      fs.readSync(fd, prevByte, 0, 1, start - 1);
      if (prevByte[0] !== 0x0a) start = 0;
    }
    chunk = Buffer.alloc(size - start);
    fs.readSync(fd, chunk, 0, chunk.length, start);
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    if (start !== session.ingest_offset) setIngestOffset(db, input.sessionId, start);
    return { inserted: 0, duplicates: 0, offset: start };
  }
  const end = start + lastNewline + 1; // never consume a trailing partial line
  const items = parseTranscriptLines(chunk.subarray(0, lastNewline + 1).toString('utf8'), {
    ingestToolResults: input.ingestToolResults ?? false,
  });

  let inserted = 0;
  let duplicates = 0;
  db.transaction(() => {
    for (const item of items) {
      const r = appendEvent(db, {
        sessionId: input.sessionId,
        role: item.role,
        kind: item.kind,
        content: item.text,
        ts: item.ts || undefined,
        project: input.project ?? session.project,
        sourceRef: item.uuid,
      });
      if (r.inserted) inserted++;
      else duplicates++;
    }
    setIngestOffset(db, input.sessionId, end);
  })();
  return { inserted, duplicates, offset: end };
}
