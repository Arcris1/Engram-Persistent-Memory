import { dbPath } from '../../config.js';
import { openDb } from '../../storage/db.js';
import { formatStats, getStats } from '../../storage/stats.js';

export function statsCommand(args: string[]): number {
  const file = dbPath();
  const db = openDb(file);
  try {
    const stats = getStats(db, file);
    process.stdout.write(args.includes('--json') ? `${JSON.stringify(stats, null, 2)}\n` : `${formatStats(stats)}\n`);
    return 0;
  } finally {
    db.close();
  }
}
