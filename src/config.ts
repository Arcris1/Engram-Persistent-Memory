import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

export function dbPath(): string {
  const raw = process.env.ENGRAM_DB;
  if (!raw) return path.join(os.homedir(), '.engram', 'engram.db');
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`ENGRAM_DB must be an absolute path (got: ${raw})`);
  }
  return expanded;
}

export function dataDir(): string {
  return path.dirname(dbPath());
}

/** D10: next to the DB (~/.engram/hooks.log by default). */
export function hooksLogPath(): string {
  return path.join(dataDir(), 'hooks.log');
}

/**
 * D42/Phase 6: local ONNX embedding, off by default. `enabled` only turns the feature on when
 * `modelDir` and `sha256` are also set -- loadEmbedder() (src/embed/load.ts) re-verifies the
 * model file's sha256 against this value before ever creating a session (§9.4: no network, and a
 * swapped/corrupted model file is refused rather than silently loaded).
 */
export const EmbeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  modelDir: z.string().default(''),
  sha256: z.string().default(''),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

const DEFAULT_EMBEDDING_CONFIG = EmbeddingConfigSchema.parse({});

export interface EngramConfig {
  /** D4.2: ingest tool_result blocks from transcripts. Default false (noise, size). */
  ingestToolResults: boolean;
  /** D42: local embedding model config. Default disabled. */
  embedding: EmbeddingConfig;
}

export function loadConfig(): EngramConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8')) as Record<string, unknown>;
    const embedding = EmbeddingConfigSchema.safeParse(raw.embedding ?? {});
    return {
      ingestToolResults: raw.ingestToolResults === true,
      embedding: embedding.success ? embedding.data : DEFAULT_EMBEDDING_CONFIG,
    };
  } catch {
    return { ingestToolResults: false, embedding: DEFAULT_EMBEDDING_CONFIG };
  }
}
