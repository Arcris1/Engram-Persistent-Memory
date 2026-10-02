import type { Embedder } from './embedder.js';

const DEFAULT_DIM = 384;

/**
 * Deterministic, dependency-free embedder for tests and any code path that must not require the
 * optional ONNX stack. Feature-hashes lowercased words into a fixed-size vector and L2-normalises
 * it. The same text always yields the same vector; there is no model, no I/O, no randomness.
 */
export function createFakeEmbedder(dim: number = DEFAULT_DIM): Embedder {
  return {
    model: 'fake',
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => embedOne(text, dim));
    },
  };
}

function embedOne(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const word of words) {
    // FNV-1a: cheap, stable, deterministic across runs/platforms for a given string.
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
      h ^= word.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const bucket = (h >>> 0) % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[bucket] += sign;
  }
  l2normalize(vec);
  return vec;
}

function l2normalize(vec: Float32Array): void {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) normSq += vec[i] * vec[i];
  if (normSq === 0) {
    // Degenerate input (empty/whitespace-only text): still return a unit vector.
    vec[0] = 1;
    return;
  }
  const norm = Math.sqrt(normSq);
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
}
