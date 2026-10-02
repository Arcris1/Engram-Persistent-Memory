import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { formatStats, getStats, StatsSchema } from '../../storage/stats.js';
import type { ToolContext } from '../server.js';

export function registerStatsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_stats',
    {
      title: 'Memory statistics',
      description:
        'Counts, database size, oldest/newest event, unconsolidated sessions and flagged-item counts for the engram memory store.',
      inputSchema: z.object({}),
      outputSchema: StatsSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const stats = getStats(ctx.db, ctx.dbFile);
      return { content: [{ type: 'text', text: formatStats(stats) }], structuredContent: stats };
    },
  );
}
