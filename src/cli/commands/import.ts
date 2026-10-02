import fs from 'node:fs';
import { dbPath } from '../../config.js';
import { importData, type ExportFile, type ImportResult } from '../../control/export.js';
import { isPaused, PAUSED_TEXT } from '../../control/pause.js';
import { openDb } from '../../storage/db.js';

const TABLE_ORDER: (keyof ImportResult)[] = [
  'events',
  'sessions',
  'claims',
  'claim_sources',
  'marks',
  'accesses',
  'tombstones',
];

function formatResult(r: ImportResult): string {
  return `${TABLE_ORDER.map((table) => `  ${table}: ${r[table].inserted} inserted, ${r[table].skipped} skipped`).join('\n')}\n`;
}

/**
 * `engram import <file>`: additive-only restore (never overwrites an existing id), one IMMEDIATE
 * transaction. While paused, refuses before even opening the DB -- exact text per Global Constraints.
 */
export function importCommand(args: string[]): number {
  const [file] = args;
  if (!file) throw new Error('import: usage: engram import <file>');

  if (isPaused()) {
    process.stderr.write(`${PAUSED_TEXT}\n`);
    return 1;
  }

  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw) as ExportFile;
  const db = openDb(dbPath());
  try {
    const result = importData(db, data);
    process.stdout.write(formatResult(result));
    return 0;
  } finally {
    db.close();
  }
}
