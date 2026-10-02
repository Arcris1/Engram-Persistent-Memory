/**
 * D8: build a safe FTS5 MATCH expression from free text. Every token is quoted, so user input can
 * never be parsed as FTS5 syntax. OR maximises recall; BM25 ranks multi-term matches first.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
