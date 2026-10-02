import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AccessRow } from '../../claims/explain.js';
import { explain } from '../../claims/explain.js';
import { EVENT_KINDS, ROLES, SCOPES } from '../../core/types.js';
import type { ToolContext } from '../server.js';
import { DATA_PREAMBLE, formatExplanation } from '../wrap.js';

const AccessRowSchema: z.ZodType<AccessRow> = z.object({
  id: z.string(),
  ts: z.string(),
  target_id: z.string(),
  query: z.string().nullable(),
  used: z.number(),
});

const ClaimRowSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  statement: z.string(),
  scope: z.enum(SCOPES),
  confidence: z.number(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  recorded_at: z.string(),
  superseded_by: z.string().nullable(),
  status: z.enum(['active', 'superseded', 'retracted']),
  importance: z.number(),
  access_count: z.number(),
  last_accessed: z.string().nullable(),
  project: z.string().nullable(),
  flags: z.array(z.string()),
});

const EventRowSchema = z.object({
  id: z.string(),
  ts: z.string(),
  session_id: z.string(),
  project: z.string().nullable(),
  role: z.enum(ROLES),
  kind: z.enum(EVENT_KINDS),
  content: z.string(),
  content_hash: z.string(),
  source_ref: z.string(),
  scope: z.enum(SCOPES),
  flags: z.array(z.string()),
});

const ExplanationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('claim'),
    item: ClaimRowSchema,
    sources: z.array(z.object({ event: EventRowSchema, excerpt: z.string().nullable() })),
    superseded_by: ClaimRowSchema.nullable(),
    supersedes: z.array(ClaimRowSchema),
    access_history: z.array(AccessRowSchema),
  }),
  z.object({
    kind: z.literal('event'),
    item: EventRowSchema,
    derived_claims: z.array(z.object({ claim: ClaimRowSchema, source_ids: z.array(z.string()) })),
    access_history: z.array(AccessRowSchema),
  }),
]);

export function registerExplainTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'memory_explain',
    {
      title: 'Explain a claim or event',
      description:
        'Explain where a claim or event came from: its cited sources, the claims derived from an event, ' +
        'its supersede chain and its access history. Takes a claim or event id.',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ notice: z.string(), explanation: ExplanationSchema }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const explanation = explain(ctx.db, id);
      if (!explanation) throw new Error(`no claim or event with id ${id}`);
      return {
        content: [{ type: 'text', text: formatExplanation(explanation) }],
        structuredContent: { notice: DATA_PREAMBLE, explanation },
      };
    },
  );
}
