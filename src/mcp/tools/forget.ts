import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readClaim } from '../../claims/claims.js';
import { dataDir } from '../../config.js';
import { claimSourceEventsNote, forget, survivalNote, type ForgetResult } from '../../control/forget.js';
import { isPaused, pausedToolResult, PausedOutputSchema } from '../../control/pause.js';
import { truncateUtf16 } from '../../core/text.js';
import { readEvent } from '../../events/events.js';
import type { ToolContext } from '../server.js';
import { DATA_PREAMBLE, attr, neutralize } from '../wrap.js';

const PREVIEW_CHARS = 120;

function describeItem(ctx: ToolContext, kind: 'event' | 'claim', id: string): string {
  const text =
    kind === 'event'
      ? (readEvent(ctx.db, id)?.content ?? '')
      : (readClaim(ctx.db, id)?.statement ?? '');
  return `<memory kind="${kind}" id="${attr(id)}">${neutralize(truncateUtf16(text, PREVIEW_CHARS))}</memory>`;
}

function formatForget(ctx: ToolContext, result: ForgetResult, confirm: boolean): string {
  const { plan, deleted } = result;
  if (confirm) {
    const marks = plan.marks_added.length ? ` Added ${plan.marks_added.length} resurrection-guard mark(s).` : '';
    const note = `Note: existing export files (e.g. in ${dataDir()}) still contain this content; delete them if needed.`;
    // H8: say so when the WAL couldn't be fully checkpointed right now -- the deletion itself is
    // still final (secure_delete already zeroed the freed pages at commit).
    const checkpointNote = result.checkpointed
      ? ''
      : '\n\nNote: the WAL could not be fully checkpointed right now (likely another open connection); the deletion is final, but the WAL file may still hold its pre-image until a later checkpoint.';
    // Task 0: same reasoning as checkpointed -- the deletion is already final either way.
    const optimizeNote = result.optimized
      ? ''
      : '\n\nNote: an FTS optimize step failed after the delete committed; the deletion is final, but a leftover indexed term may remain until a later optimize succeeds.';
    return `Deleted ${deleted.events} event(s) and ${deleted.claims} claim(s).${marks}${checkpointNote}${optimizeNote}\n\n${note}`;
  }

  const items = [
    ...plan.events.map((id) => describeItem(ctx, 'event', id)),
    ...plan.claims.map((id) => describeItem(ctx, 'claim', id)),
  ];
  const body = items.length ? items.join('\n') : 'Nothing to delete.';
  const marks = plan.marks_added.length
    ? `\n\nResurrection-guard marks that would be added: ${plan.marks_added.join(', ')}`
    : '';
  const note = survivalNote(plan);
  const survival = note ? `\n\n${note}` : '';
  const sourceNote = claimSourceEventsNote(plan);
  const sources = sourceNote ? `\n\n${sourceNote}` : '';
  return (
    `${DATA_PREAMBLE}\n\n` +
    `Forgetting ${plan.target.kind} ${attr(plan.target.id)} would delete ${deleted.events} event(s) and ` +
    `${deleted.claims} claim(s):\n\n${body}${marks}${survival}${sources}\n\n` +
    `Call again with confirm=true after the user approves.`
  );
}

export function registerForgetTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_forget',
    {
      title: 'Forget a memory',
      description:
        'Physically and permanently delete an event or claim -- the only delete path for stored memory ' +
        '(§9.5). Call with confirm=false first to preview exactly what would be deleted, show it to the ' +
        'user, and call again with confirm=true only after the user approves. Deletion is irreversible: ' +
        'secure_delete, an FTS rebuild and a WAL checkpoint remove the content from disk, and a resurrection ' +
        'guard stops it from being silently re-ingested (forgotten event) or re-derived (forgotten claim).',
      inputSchema: z.object({ id: z.string(), confirm: z.boolean() }),
      outputSchema: z.union([
        z.object({
          deleted: z.object({ events: z.number(), claims: z.number(), marks_deleted: z.number() }),
          plan: z.object({
            target: z.object({ kind: z.enum(['event', 'claim']), id: z.string() }),
            events: z.array(z.string()),
            claims: z.array(z.string()),
            marks_added: z.array(z.string()),
            surviving_claims: z.array(z.string()),
            same_content_events: z.array(z.string()),
            source_events: z.array(z.string()),
          }),
          rebuilt: z.boolean(),
          checkpointed: z.boolean(),
          optimized: z.boolean(),
        }),
        PausedOutputSchema,
      ]),
    },
    async ({ id, confirm }) => {
      // Preview (confirm=false) is a read and keeps working while paused; only the confirmed delete is guarded.
      if (confirm && isPaused()) return pausedToolResult();
      const result = forget(ctx.db, id, { confirm });
      return {
        content: [{ type: 'text', text: formatForget(ctx, result, confirm) }],
        structuredContent: result,
      };
    },
  );
}
