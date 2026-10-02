import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { recordFeedback } from '../../claims/access.js';
import { isPaused, pausedToolResult, PausedOutputSchema } from '../../control/pause.js';
import { rebuild } from '../../control/rebuild.js';
import { nowIso } from '../../core/ids.js';
import type { ToolContext } from '../server.js';

const FeedbackResultSchema = z.object({ updated: z.number() });
const RebuildResultSchema = z.object({ fts_checksum: z.string(), importance_checksum: z.string() });

/**
 * §6.8 `memory_feedback`: Claude calls this after using retrieved memories so importance can learn
 * from actual use (§7). A write tool -- guarded the same way as every other guarded write tool
 * (isPaused()/pausedToolResult()).
 */
export function registerFeedbackTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_feedback',
    {
      title: 'Report memory usage',
      description:
        'After using retrieved memories, report which ones you actually relied on (§6.8). Marks the ' +
        'most recent access to each id as used (or not), then recomputes its importance (§7) so useful ' +
        'memories surface more readily over time. Unknown ids are skipped and not counted.',
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(50), used: z.boolean() }),
      outputSchema: z.union([FeedbackResultSchema, PausedOutputSchema]),
    },
    async ({ ids, used }) => {
      if (isPaused()) return pausedToolResult();
      const result = recordFeedback(ctx.db, ids, used, nowIso());
      return {
        content: [{ type: 'text', text: `Recorded feedback for ${result.updated} of ${ids.length} id(s).` }],
        structuredContent: result,
      };
    },
  );
}

/**
 * §6.11 `memory_rebuild`: rebuilds `events_fts`/`claims_fts` from their source tables and recomputes
 * every claim's importance (§7); does **not** re-extract claims. A write tool -- guarded the same way
 * as every other guarded write tool.
 */
export function registerRebuildTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_rebuild',
    {
      title: 'Rebuild derived memory views',
      description:
        'Rebuild the full-text search indexes from events/claims and recompute every claim\'s ' +
        'importance from usage + pins (§6.11/§7). Does not re-extract claims -- use /consolidate for ' +
        'that. Returns checksums over the rebuilt FTS contents and the recomputed importance values.',
      inputSchema: z.object({}),
      outputSchema: z.union([RebuildResultSchema, PausedOutputSchema]),
    },
    async () => {
      if (isPaused()) return pausedToolResult();
      const result = rebuild(ctx.db, nowIso());
      return {
        content: [
          {
            type: 'text',
            text: `Rebuilt FTS indexes and recomputed importance (fts_checksum=${result.fts_checksum.slice(0, 12)}…, importance_checksum=${result.importance_checksum.slice(0, 12)}…).`,
          },
        ],
        structuredContent: result,
      };
    },
  );
}
