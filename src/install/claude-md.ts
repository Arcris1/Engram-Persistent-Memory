/**
 * Pure marker-block editing for `<claude-dir>/CLAUDE.md`. No filesystem I/O here, so install.ts can
 * read the file once, transform it, and decide whether (and how) to write/back it up.
 */

export const BEGIN_MARKER = '<!-- engram:begin -->';
export const END_MARKER = '<!-- engram:end -->';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BLOCK_RE = new RegExp(`${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`);
/** Matches the block plus exactly one of the (at most two) newlines `upsertClaudeMdSnippet` put in
 * front of it -- the other newline, when present, is the original content's own trailing newline
 * and must survive removal. */
const BLOCK_WITH_ONE_LEADING_NEWLINE_RE = new RegExp(`\\n?${BLOCK_RE.source}`);

export const MALFORMED_MARKERS_MESSAGE =
  'CLAUDE.md has malformed engram markers; fix them by hand (expected one <!-- engram:begin --> ... <!-- engram:end --> block)';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * `BLOCK_RE` is non-global and only ever looks for a single well-formed block, so a dangling begin
 * or end marker, or more than one complete block, would silently corrupt the file. Call this first
 * and let install/uninstall abort before writing anything when it throws.
 */
export function validateClaudeMdMarkers(content: string): void {
  const begins = countOccurrences(content, BEGIN_MARKER);
  const ends = countOccurrences(content, END_MARKER);
  if (begins !== ends || begins > 1) {
    throw new Error(MALFORMED_MARKERS_MESSAGE);
  }
}

/**
 * Inserts the engram block at the end of `content` with a blank-line separator, or replaces it in
 * place if the markers are already present anywhere in the file -- idempotent, and
 * `removeClaudeMdSnippet` is its exact inverse for content that already ends with a newline (true
 * of any normal text file) or is empty. Throws (see `validateClaudeMdMarkers`) instead of touching a
 * file with malformed markers.
 */
export function upsertClaudeMdSnippet(content: string, snippet: string): string {
  validateClaudeMdMarkers(content);
  const block = `${BEGIN_MARKER}\n${snippet.replace(/\n+$/, '')}\n${END_MARKER}\n`;
  if (BLOCK_RE.test(content)) return content.replace(BLOCK_RE, block);
  if (content.length === 0) return block;
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${sep}${block}`;
}

/** Removes the engram block and the one separator newline `upsertClaudeMdSnippet` added before it. */
export function removeClaudeMdSnippet(content: string): string {
  validateClaudeMdMarkers(content);
  if (!BLOCK_RE.test(content)) return content;
  return content.replace(BLOCK_WITH_ONE_LEADING_NEWLINE_RE, '');
}
