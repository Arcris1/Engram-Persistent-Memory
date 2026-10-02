import { describe, expect, it } from 'vitest';
import { createFakeEmbedder } from '../src/embed/fake.js';

function l2norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

describe('createFakeEmbedder', () => {
  it('reports the requested model/dim', () => {
    const embedder = createFakeEmbedder(16);
    expect(embedder.model).toBe('fake');
    expect(embedder.dim).toBe(16);
  });

  it('defaults to dim 384 (matches the real MiniLM model)', () => {
    expect(createFakeEmbedder().dim).toBe(384);
  });

  it('is deterministic: the same text embeds to the same vector', async () => {
    const embedder = createFakeEmbedder();
    const [a] = await embedder.embed(['the quick brown fox']);
    const [b] = await embedder.embed(['the quick brown fox']);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different texts embed to different vectors', async () => {
    const embedder = createFakeEmbedder();
    const [a, b] = await embedder.embed(['the quick brown fox', 'completely unrelated text']);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('every output vector has L2 norm 1', async () => {
    const embedder = createFakeEmbedder();
    const vectors = await embedder.embed(['hello world', 'a', '', 'engram memory claim text']);
    for (const v of vectors) {
      expect(v.length).toBe(384);
      expect(l2norm(v)).toBeCloseTo(1, 6);
    }
  });

  it('handles an empty batch', async () => {
    const embedder = createFakeEmbedder();
    expect(await embedder.embed([])).toEqual([]);
  });
});
