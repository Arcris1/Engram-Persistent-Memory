import { explain, type Explanation } from '../../claims/explain.js';
import { dbPath } from '../../config.js';
import { stripControlChars } from '../../core/text.js';
import { openDb } from '../../storage/db.js';

/**
 * H8: unlike `list`'s one-line-per-row format, `explain` prints full bodies (a claim's statement, an
 * event's content, a source excerpt) where a real line break is meaningful and worth keeping -- only
 * other ASCII control characters (a bare ESC that could forge a terminal escape sequence, a NUL,
 * etc.) are stripped. Horizontal whitespace runs still collapse to one space, and a run of 3+
 * newlines collapses to one blank line, so stored content can't blow up the printed output's shape.
 */
function cleanBody(s: string): string {
  return stripControlChars(s, { keepNewline: true })
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatExplanation(e: Explanation): string {
  const lines: string[] = [];
  if (e.kind === 'claim') {
    const c = e.item;
    lines.push(`claim ${c.id}: ${cleanBody(c.statement)}`);
    // H8: subject/predicate/object share one structured metadata line (not a "body"), so a stray
    // control character here -- including a bare \n -- is stripped outright rather than kept.
    lines.push(
      `  subject: ${stripControlChars(c.subject)}  predicate: ${stripControlChars(c.predicate)}  object: ${stripControlChars(c.object)}`,
    );
    lines.push(`  status: ${c.status}  scope: ${c.scope}  confidence: ${c.confidence}  importance: ${c.importance}`);
    lines.push('  sources:');
    for (const s of e.sources) {
      lines.push(`    ${s.event.id} (${s.event.ts}): ${cleanBody(s.excerpt ?? '(no excerpt)')}`);
    }
    if (e.superseded_by) lines.push(`  superseded by: ${e.superseded_by.id}`);
    if (e.supersedes.length > 0) lines.push(`  supersedes: ${e.supersedes.map((sc) => sc.id).join(', ')}`);
    lines.push(`  accessed: ${e.access_history.length} time(s)`);
  } else {
    const ev = e.item;
    lines.push(`event ${ev.id} (${ev.ts}): ${cleanBody(ev.content)}`);
    if (e.derived_claims.length > 0) {
      lines.push('  derived claims:');
      for (const d of e.derived_claims) lines.push(`    ${d.claim.id}: ${cleanBody(d.claim.statement)}`);
    } else {
      lines.push('  derived claims: none');
    }
    lines.push(`  accessed: ${e.access_history.length} time(s)`);
  }
  return `${lines.join('\n')}\n`;
}

/** `engram explain <id>`: the claim chain, or an event plus the claims derived from it. */
export function explainCommand(args: string[]): number {
  const [id] = args;
  if (!id) throw new Error('explain: usage: engram explain <id>');

  const db = openDb(dbPath());
  try {
    const result = explain(db, id);
    if (!result) throw new Error(`no claim or event with id ${id}`);
    process.stdout.write(formatExplanation(result));
    return 0;
  } finally {
    db.close();
  }
}
