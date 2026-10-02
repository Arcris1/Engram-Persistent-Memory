export function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  // Check if the character at max - 1 is a high surrogate (0xD800–0xDBFF)
  const codeUnit = text.charCodeAt(max - 1);
  const sliceAt = codeUnit >= 0xd800 && codeUnit <= 0xdbff ? max - 1 : max;
  return text.slice(0, sliceAt);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * H8: strips ASCII control characters (C0 controls 0x00-0x1F plus DEL 0x7F -- e.g. a bare ESC that
 * could otherwise forge a terminal escape sequence, or a NUL) from text about to be printed to a
 * terminal. `keepNewline: true` leaves `\n` (0x0A) alone -- `engram explain`'s multi-line bodies want
 * to keep real line breaks; `engram list`'s one-line-per-row format does not (the default).
 */
export function stripControlChars(text: string, opts: { keepNewline?: boolean } = {}): string {
  const re = opts.keepNewline ? /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g : /[\x00-\x1F\x7F]/g;
  return text.replace(re, '');
}
