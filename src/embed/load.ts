import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngramConfig } from '../config.js';
import type { Embedder } from './embedder.js';

const MODEL_FILE = 'model_quantized.onnx';
const REQUIRED_FILES = [MODEL_FILE, 'tokenizer.json', 'tokenizer_config.json'];

export interface LoadEmbedderResult {
  embedder: Embedder | null;
  /** 'ok' when embedder is non-null; otherwise why it's null, for logs and `engram model verify`. */
  reason: string;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Resolve, sha256-verify and (only then) load the local embedding model. Every check up to the
 * dynamic `import('./onnx.js')` at the end uses only `node:fs`/`node:crypto` -- so a disabled or
 * misconfigured embedder never imports onnxruntime-node or @huggingface/tokenizers, which keeps
 * their load cost, install size and attack surface opt-in (D42). This also never touches the
 * network (HANDOFF §9.4): the model is read only from the local directory named in config.
 */
export async function tryLoadEmbedder(config: EngramConfig): Promise<LoadEmbedderResult> {
  const { embedding } = config;
  if (!embedding.enabled) {
    return { embedder: null, reason: 'disabled' };
  }
  if (!embedding.modelDir) {
    return { embedder: null, reason: 'embedding.modelDir is not configured' };
  }
  if (!embedding.sha256) {
    return { embedder: null, reason: 'embedding.sha256 is not configured' };
  }
  const dir = expandHome(embedding.modelDir);
  // Phase 6 review: a relative path would silently resolve against whatever cwd the MCP server/hook
  // happens to have, so refuse it (surfaced by `engram model verify`).
  if (!path.isAbsolute(dir)) {
    return { embedder: null, reason: `embedding.modelDir must be an absolute path or start with ~ (got '${embedding.modelDir}')` };
  }
  for (const name of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, name))) {
      return { embedder: null, reason: `missing model file: ${path.join(dir, name)}` };
    }
  }
  let actual: string;
  try {
    actual = sha256File(path.join(dir, MODEL_FILE));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { embedder: null, reason: `could not read ${MODEL_FILE}: ${message}` };
  }
  const expected = embedding.sha256.trim().toLowerCase();
  if (actual !== expected) {
    return { embedder: null, reason: `sha256 mismatch for ${MODEL_FILE} (expected ${expected}, got ${actual})` };
  }
  try {
    const { createOnnxEmbedder } = await import('./onnx.js');
    const embedder = await createOnnxEmbedder(dir, actual);
    return { embedder, reason: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { embedder: null, reason: `failed to load model: ${message}` };
  }
}

/**
 * Convenience wrapper for the common case (MCP server, backfill): collapses to `Embedder | null`
 * and logs the reason to stderr whenever embedding was *expected* to work but didn't (anything
 * other than the default 'disabled' state, which would otherwise spam every call).
 */
export async function loadEmbedder(config: EngramConfig): Promise<Embedder | null> {
  const { embedder, reason } = await tryLoadEmbedder(config);
  if (!embedder && reason !== 'disabled') {
    process.stderr.write(`engram: embedding unavailable (${reason})\n`);
  }
  return embedder;
}
