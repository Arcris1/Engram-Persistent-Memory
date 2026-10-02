import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { isPaused, pausedToolResult, PausedOutputSchema } from '../../control/pause.js';
import { SCOPES } from '../../core/types.js';
import { embedAfterWrite } from '../../embed/postwrite.js';
import { appendEvent } from '../../events/events.js';
import type { ToolContext } from '../server.js';

export function registerRecordTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_record',
    {
      title: 'Record a memory',
      description:
        'Store something the user explicitly asked you to remember ("remember this", "don\'t forget"). ' +
        'Appended to the memory log as data (secrets are redacted); /consolidate later turns it into cited claims.',
      inputSchema: z.object({
        content: z.string().max(64 * 1024).refine((s) => s.trim().length > 0, 'content is empty'),
        scope: z.enum(SCOPES).optional(),
        project: z.string().nullable().optional(),
        kind: z.enum(['explicit_remember', 'note']).optional(),
      }),
      outputSchema: z.union([
        z.object({ event_id: z.string(), forgotten: z.boolean().optional() }),
        PausedOutputSchema,
      ]),
    },
    async ({ content, scope, project, kind }) => {
      if (isPaused()) return pausedToolResult();
      const r = appendEvent(ctx.db, {
        sessionId: ctx.sessionId(),
        role: 'user',
        kind: kind ?? 'explicit_remember',
        content,
        scope,
        project: project === undefined ? ctx.defaultProject : project,
      });
      // H8: a tombstoned re-ingest (D32) means this exact content was deliberately forgotten earlier
      // -- say so plainly rather than reporting a hollow "Recorded memory ." with an empty id.
      if (r.tombstoned) {
        return {
          content: [{ type: 'text', text: 'Not recorded: this content was forgotten earlier.' }],
          structuredContent: { event_id: '', forgotten: true },
        };
      }
      // D42/Phase 6 Task 2: embed the new (or re-confirmed) event after the write -- a no-op when
      // embedding is disabled, and never allowed to fail or throw out of this tool call (see
      // embedAfterWrite's own doc comment).
      await embedAfterWrite(ctx.db, await ctx.embedder(), { kind: 'event', id: r.id });
      const note = r.inserted ? '' : ' (already recorded)';
      return {
        content: [{ type: 'text', text: `Recorded memory ${r.id}${note}.` }],
        structuredContent: { event_id: r.id },
      };
    },
  );
}
