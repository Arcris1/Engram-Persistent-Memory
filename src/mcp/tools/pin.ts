import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { pin, unpin, type PinResult } from '../../control/marks.js';
import { isPaused, pausedToolResult, PausedOutputSchema } from '../../control/pause.js';
import type { ToolContext } from '../server.js';

const PinResultSchema = z.object({ id: z.string(), pinned: z.boolean(), importance: z.number() });

function formatPin(result: PinResult): string {
  const verb = result.pinned ? 'Pinned' : 'Unpinned';
  return `${verb} claim ${result.id} (importance ${result.importance}).`;
}

export function registerPinTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_pin',
    {
      title: 'Pin a claim',
      description:
        'Pin a claim so it is always kept in the profile and never crowded out (§6.9): sets importance ' +
        'to 1.0. The claim must already exist.',
      inputSchema: z.object({ id: z.string(), note: z.string().optional() }),
      outputSchema: z.union([PinResultSchema, PausedOutputSchema]),
    },
    async ({ id, note }) => {
      if (isPaused()) return pausedToolResult();
      const result = pin(ctx.db, id, note);
      return { content: [{ type: 'text', text: formatPin(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    'memory_unpin',
    {
      title: 'Unpin a claim',
      description:
        'Unpin a previously pinned claim (§6.9): removes the pinned mark and recomputes importance ' +
        '(0.8 if any source event is explicit_remember, else 0.5). The claim must already exist.',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.union([PinResultSchema, PausedOutputSchema]),
    },
    async ({ id }) => {
      if (isPaused()) return pausedToolResult();
      const result = unpin(ctx.db, id);
      return { content: [{ type: 'text', text: formatPin(result) }], structuredContent: result };
    },
  );
}
