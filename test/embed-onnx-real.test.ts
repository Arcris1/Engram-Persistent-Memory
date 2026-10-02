import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngramConfig } from '../src/config.js';
import { tryLoadEmbedder } from '../src/embed/load.js';
import { runCli, tmpDbFile } from './helpers.js';

/**
 * Optional real-model test (Task 1 brief): only runs when ENGRAM_EMBED_MODEL_DIR and
 * ENGRAM_EMBED_MODEL_SHA256 are both set, e.g. pointing at a local copy of the quantized
 * all-MiniLM-L6-v2 ONNX export. The rest of the suite never requires this -- the fake embedder
 * (src/embed/fake.ts) covers everything else deterministically.
 */
const modelDir = process.env.ENGRAM_EMBED_MODEL_DIR;
const sha256 = process.env.ENGRAM_EMBED_MODEL_SHA256;
const hasModel = Boolean(modelDir && sha256);

function l2norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

describe.skipIf(!hasModel)('real ONNX embedder (ENGRAM_EMBED_MODEL_DIR + _SHA256 set)', () => {
  const config: EngramConfig = {
    ingestToolResults: false,
    embedding: { enabled: true, modelDir: modelDir ?? '', sha256: sha256 ?? '' },
  };

  it('loads, dim 384, L2-normalised, same text scores cosine ~1 against itself', async () => {
    const { embedder, reason } = await tryLoadEmbedder(config);
    expect(reason).toBe('ok');
    expect(embedder).not.toBeNull();
    if (!embedder) return;
    expect(embedder.dim).toBe(384);

    const text = 'engram remembers project decisions across sessions';
    const [a, b] = await embedder.embed([text, text]);
    expect(a.length).toBe(384);
    expect(l2norm(a)).toBeCloseTo(1, 4);
    expect(l2norm(b)).toBeCloseTo(1, 4);
    expect(dot(a, b)).toBeCloseTo(1, 4);
  });

  it('distinct, unrelated texts do not score cosine ~1', async () => {
    const { embedder } = await tryLoadEmbedder(config);
    if (!embedder) throw new Error('expected embedder to load');
    const [a, b] = await embedder.embed([
      'the quarterly revenue report is due Friday',
      'cats sleep for most of the day',
    ]);
    expect(dot(a, b)).toBeLessThan(0.9);
  });

  it('embeds many texts (one inference run per text, fix round 2) and truncates long input', async () => {
    const { embedder } = await tryLoadEmbedder(config);
    if (!embedder) throw new Error('expected embedder to load');
    const short = Array.from({ length: 40 }, (_, i) => `claim number ${i}`);
    const long = 'word '.repeat(5000).trim(); // far beyond the 256-token truncation limit
    const vectors = await embedder.embed([...short, long]);
    expect(vectors.length).toBe(41);
    for (const v of vectors) {
      expect(v.length).toBe(384);
      expect(l2norm(v)).toBeCloseTo(1, 3);
    }
  });

  it('fix round 2: embed(all)[i] is identical to embed([text_i])[0], including same-length/different-content pairs', async () => {
    const { embedder } = await tryLoadEmbedder(config);
    if (!embedder) throw new Error('expected embedder to load');
    // Fix round 1 (length-bucketed, unpadded batching) made this hold only for texts of *distinct*
    // token lengths -- two different texts that happened to tokenize to the *same* length still
    // diverged (DynamicQuantizeLinear's per-call activation scale spans the whole batch tensor, not
    // one row). Fix round 2 embeds exactly one text per inference run, always, so there is no
    // batch tensor to share a scale across in the first place -- this must hold for every text here,
    // deliberately including same-length collisions ('short'/'x' both 3 tokens; the two sentences
    // below both 14 tokens -- confirmed offline against this model's tokenizer).
    const texts = [
      'short',
      'x',
      'the system stores memory claims',
      'cats sleep for most of the day',
      'engram remembers project decisions across sessions and surfaces them again later',
      'the quarterly revenue report is due Friday and needs three more reviewers',
    ];
    const batched = await embedder.embed(texts);
    expect(batched.length).toBe(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const [single] = await embedder.embed([texts[i]]);
      expect(dot(batched[i], single)).toBeGreaterThanOrEqual(0.999999);
      expect(maxAbsDiff(batched[i], single)).toBeLessThan(1e-6);
    }
  });

  it('256-token truncation matches a fresh encode of the known first-256-token prefix', async () => {
    const { Tokenizer } = await import('@huggingface/tokenizers');
    const tokenizerJson = JSON.parse(fs.readFileSync(path.join(modelDir as string, 'tokenizer.json'), 'utf8'));
    const tokenizerConfig = JSON.parse(
      fs.readFileSync(path.join(modelDir as string, 'tokenizer_config.json'), 'utf8'),
    );
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

    const words = [
      'the',
      'memory',
      'system',
      'stores',
      'claims',
      'and',
      'events',
      'for',
      'every',
      'project',
      'session',
      'across',
      'time',
      'without',
      'losing',
      'context',
    ];
    const long = Array.from({ length: 600 }, (_, i) => words[i % words.length]).join(' ');
    const fullIds: number[] = tokenizer.encode(long).ids;
    expect(fullIds.length).toBeGreaterThan(256); // sanity: this input really exceeds the limit

    // Build the known first-256-token prefix exactly as createOnnxEmbedder's truncate() does:
    // keep the leading 255 tokens plus the original closing token (the [SEP]).
    const first256 = [...fullIds.slice(0, 255), fullIds[fullIds.length - 1]];
    const prefixText = tokenizer.decode(first256, { skip_special_tokens: true });

    const { embedder } = await tryLoadEmbedder(config);
    if (!embedder) throw new Error('expected embedder to load');
    const [vLong, vPrefix] = await embedder.embed([long, prefixText]);
    expect(dot(vLong, vPrefix)).toBeGreaterThan(0.99999);
  });

  it('engram model verify (CLI) prints ok, dim and a ~1 self-similarity sanity check', () => {
    const dbFile = tmpDbFile();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(dbFile), 'config.json'),
      JSON.stringify({ embedding: { enabled: true, modelDir, sha256 } }),
    );
    const r = runCli(['model', 'verify'], { dbFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stdout).toContain('dim: 384');
    expect(r.stdout).toMatch(/self-similarity: 0\.9999|self-similarity: 1\.0000/);
  });
});
