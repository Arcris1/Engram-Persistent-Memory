import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { consolidatePrompt } from '../consolidate/prompt.js';
import { loadConfig } from '../config.js';
import { newId } from '../core/ids.js';
import type { Embedder } from '../embed/embedder.js';
import { loadEmbedder } from '../embed/load.js';
import { DEFAULT_TAU } from '../search/candidates.js';
import type { Db } from '../storage/db.js';
import { VERSION } from '../version.js';
import { registerResources } from './resources.js';
import { registerPendingTool, registerClaimUpsertTool, registerResetClaimsTool } from './tools/consolidation.js';
import { registerExplainTool } from './tools/explain.js';
import { registerFeedbackTool, registerRebuildTool } from './tools/feedback.js';
import { registerForgetTool } from './tools/forget.js';
import { registerPinTools } from './tools/pin.js';
import { registerProfileTool } from './tools/profile.js';
import { registerRecordTool } from './tools/record.js';
import { registerSearchTool } from './tools/search.js';
import { registerStatsTool } from './tools/stats.js';

export interface ServerOptions {
  db: Db;
  dbFile: string;
  defaultProject?: string | null;
  /**
   * D42/Phase 6 Task 2 injection seam: tests (and anything else that wants a specific embedder, e.g.
   * the eval harness) pass this to bypass loadConfig()+loadEmbedder() entirely -- `null` forces the
   * disabled path, an `Embedder` is used as-is. Omitted (the real entrypoint, src/mcp.ts) falls back
   * to the normal lazy, memoized, config-driven load.
   */
  embedder?: Embedder | null;
  /** Phase 6 Task 3 (D42/hybrid admission): cosine >= tau OR gate A. Defaults to DEFAULT_TAU
   * (src/search/candidates.ts), the value frozen in D43 from the dev tau sweep; the eval harness
   * overrides this per `--tau` run. Irrelevant whenever `embedder()` resolves to null. */
  tau?: number;
}

export interface ToolContext {
  db: Db;
  dbFile: string;
  defaultProject: string | null;
  /** D16: one synthetic session per server process, created on first use. */
  sessionId: () => string;
  /**
   * D42/Phase 6 Task 2: memoized for the process -- loaded at most once, lazily, on first call (never
   * at server startup, so a disabled/default install never touches onnxruntime-node). Every post-write
   * embedding call site awaits this instead of calling loadEmbedder() itself.
   */
  embedder: () => Promise<Embedder | null>;
  /** Phase 6 Task 3 (D42/hybrid admission threshold). See ServerOptions.tau. */
  tau: number;
}

export function createServer(opts: ServerOptions): McpServer {
  let session: string | undefined;
  let embedderPromise: Promise<Embedder | null> | undefined;
  const ctx: ToolContext = {
    db: opts.db,
    dbFile: opts.dbFile,
    defaultProject: opts.defaultProject ?? null,
    sessionId: () => (session ??= `mcp-${newId()}`),
    embedder: () =>
      (embedderPromise ??= opts.embedder !== undefined ? Promise.resolve(opts.embedder) : loadEmbedder(loadConfig())),
    tau: opts.tau ?? DEFAULT_TAU,
  };
  const server = new McpServer({ name: 'engram', version: VERSION });
  registerStatsTool(server, ctx);
  registerRecordTool(server, ctx);
  registerSearchTool(server, ctx);
  registerPendingTool(server, ctx);
  registerClaimUpsertTool(server, ctx);
  registerExplainTool(server, ctx);
  registerResetClaimsTool(server, ctx);
  registerForgetTool(server, ctx);
  registerPinTools(server, ctx);
  registerFeedbackTool(server, ctx);
  registerRebuildTool(server, ctx);
  registerProfileTool(server, ctx);
  registerResources(server, ctx);
  registerConsolidatePrompt(server);
  return server;
}

function registerConsolidatePrompt(server: McpServer): void {
  server.registerPrompt(
    'consolidate',
    {
      title: 'Consolidate engram memory into cited claims',
      description: 'Review pending sessions and extract atomic, cited claims via memory_pending / memory_claim_upsert.',
      argsSchema: z.object({ session_id: z.string().optional() }),
    },
    ({ session_id }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: consolidatePrompt(session_id) } }],
    }),
  );
}
