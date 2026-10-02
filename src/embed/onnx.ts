import fs from 'node:fs';
import path from 'node:path';
import type { Embedder } from './embedder.js';

/**
 * Real local embedder: onnxruntime-node running the quantized all-MiniLM-L6-v2 ONNX model, tokenized
 * by @huggingface/tokenizers. Both are optional dependencies and are only ever imported from here,
 * dynamically, by loadEmbedder() (src/embed/load.ts) after it has already sha256-verified the model
 * file -- never at module load time, and never when embedding is disabled (D42).
 *
 * Fix round 2: exactly one text per inference run (batch size 1), always -- `embed(texts)` loops
 * sequentially over `texts`, running `session.run()` once per text, and returns results in the
 * same order. Fix round 1 tried length-bucketed batching (grouping same-length texts into a single
 * >1-row model call with no padding); that removed the *padding*-induced divergence, but a separate
 * cause remained: `model_quantized.onnx` is a *dynamically* activation-quantized export (its graph
 * contains `DynamicQuantizeLinear` nodes, confirmed by inspecting the file), and those compute each
 * quantization scale from the actual runtime tensor they're given. For a >1-row batch that tensor
 * spans every row, not just one, so two different texts sharing a batch are numerically entangled
 * by that shared scale -- measured at cosine ~0.976-0.994 against embedding either one alone, even
 * with zero padding. Only byte-identical rows in a shared batch were unaffected (cosine 1.0). This
 * is a property of the quantized model file, not of the batching code, and no arrangement of rows
 * within a >1-row tensor avoids it. Decision: since the embeddings written at claim/event
 * upsert time and the embeddings backfilled or recomputed later (Task 2/3) must be bit-for-bit
 * reproducible regardless of what else happened to be in the batch, determinism matters more than
 * the throughput a larger batch would buy -- and at ~2 ms per text (measured), looping has no
 * material cost. So batch size is fixed at 1: no grouping, no padding, no batch-content-dependent
 * quantization effects possible, by construction.
 *
 * Each text is tokenized and truncated to 256 tokens (keeping the trailing token -- the closing
 * [SEP] -- rather than hard-slicing it off, so a truncated encode still looks like a normal,
 * complete single-sequence encode), run through the model alone, mean-pooled over the (all-ones,
 * since there is no padding) attention mask, then L2-normalised.
 */
const DIM = 384;
const MAX_TOKENS = 256;

interface Truncated {
  ids: number[];
  mask: number[];
}

export async function createOnnxEmbedder(modelDir: string, modelSha256?: string): Promise<Embedder> {
  const ort = await import('onnxruntime-node');
  const { Tokenizer } = await import('@huggingface/tokenizers');

  const tokenizerJson = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'));
  const tokenizerConfig = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'), 'utf8'));
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const session = await ort.InferenceSession.create(path.join(modelDir, 'model_quantized.onnx'));

  function truncate(text: string): Truncated {
    const enc = tokenizer.encode(text);
    if (enc.ids.length <= MAX_TOKENS) {
      return { ids: enc.ids, mask: enc.attention_mask };
    }
    // Standard single-sequence BERT-style truncation: keep the leading [CLS] + as much content as
    // fits, but always keep the final token (the closing [SEP]) rather than silently dropping it
    // off the end -- so a truncated long input still looks like a normal, complete encode.
    const lastIdx = enc.ids.length - 1;
    return {
      ids: [...enc.ids.slice(0, MAX_TOKENS - 1), enc.ids[lastIdx]],
      mask: [...enc.attention_mask.slice(0, MAX_TOKENS - 1), enc.attention_mask[lastIdx]],
    };
  }

  /** Runs the model over exactly one text. Batch dimension is always 1 -- see file header. */
  async function embedOne(text: string): Promise<Float32Array> {
    const { ids, mask } = truncate(text);
    const len = ids.length;
    const idsArr = new BigInt64Array(len);
    const maskArr = new BigInt64Array(len);
    const typeArr = new BigInt64Array(len); // all zeros: single-sequence input.
    for (let col = 0; col < len; col++) {
      idsArr[col] = BigInt(ids[col]);
      maskArr[col] = BigInt(mask[col] ?? 1);
    }

    const feeds = {
      input_ids: new ort.Tensor('int64', idsArr, [1, len]),
      attention_mask: new ort.Tensor('int64', maskArr, [1, len]),
      token_type_ids: new ort.Tensor('int64', typeArr, [1, len]),
    };
    const outputs = await session.run(feeds);
    const hidden = outputs['last_hidden_state'] ?? Object.values(outputs)[0];
    const [outBatch, outSeq, outDim] = hidden.dims as [number, number, number];
    if (outBatch !== 1 || outSeq !== len || outDim !== DIM) {
      throw new Error(`unexpected model output shape [${hidden.dims.join(',')}], expected [1,${len},${DIM}]`);
    }
    const data = hidden.data as Float32Array;

    const vec = new Float32Array(DIM);
    let count = 0;
    for (let col = 0; col < len; col++) {
      if (maskArr[col] === 0n) continue; // defensive: this input has no padding, so always true
      count++;
      const base = col * DIM;
      for (let d = 0; d < DIM; d++) vec[d] += data[base + d];
    }
    const denom = count || 1;
    let normSq = 0;
    for (let d = 0; d < DIM; d++) {
      vec[d] /= denom;
      normSq += vec[d] * vec[d];
    }
    const norm = Math.sqrt(normSq) || 1;
    for (let d = 0; d < DIM; d++) vec[d] /= norm;
    return vec;
  }

  return {
    // Phase 6 review (model identity): the stored model string carries a short prefix of the verified
    // model file's sha256, so swapping the model file makes every older vector stale.
    model: `all-MiniLM-L6-v2-q${modelSha256 ? `@${modelSha256.slice(0, 8)}` : ''}`,
    dim: DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const results: Float32Array[] = [];
      for (const text of texts) {
        results.push(await embedOne(text));
      }
      return results;
    },
  };
}
