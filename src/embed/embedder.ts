/**
 * Phase 6 (D42): the embedding interface shared by the real ONNX embedder (src/embed/onnx.ts)
 * and the deterministic fake used everywhere in tests (src/embed/fake.ts). Callers never import
 * either implementation directly -- they go through loadEmbedder() (src/embed/load.ts), which
 * decides which one (if any) to hand back.
 */
export interface Embedder {
  /** Identifies the model, e.g. for logging/explain -- not used for cache invalidation here. */
  readonly model: string;
  /** Output vector length. Every vector embed() returns has exactly this many components. */
  readonly dim: number;
  /**
   * Callers may pass any number of texts; results come back in the same order. The real ONNX
   * embedder (src/embed/onnx.ts) processes exactly one text per model call -- see its file header
   * for why (dynamic activation quantization makes a >1-row batch's results content-dependent).
   */
  embed(texts: string[]): Promise<Float32Array[]>;
}
