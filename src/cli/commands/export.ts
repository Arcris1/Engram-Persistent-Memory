import { dbPath } from '../../config.js';
import { writeExport } from '../../control/export.js';
import { openDb } from '../../storage/db.js';

function parseFlags(args: string[]): { out?: string } {
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
  }
  return { out };
}

/** `engram export [--out <file>]`: writes the JSON export (mode 0600) and prints its path. */
export function exportCommand(args: string[]): number {
  const { out } = parseFlags(args);
  const db = openDb(dbPath());
  try {
    const file = writeExport(db, out);
    process.stdout.write(`${file}\n`);
    return 0;
  } finally {
    db.close();
  }
}
