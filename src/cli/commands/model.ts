import { loadConfig } from '../../config.js';
import { tryLoadEmbedder } from '../../embed/load.js';

const USAGE = `usage: engram model verify\n`;

export async function modelCommand(args: string[]): Promise<number> {
  const [sub, ...extra] = args;
  if (sub === 'verify') {
    // Phase 6 review: same strictness as `engram embed` -- a typo'd flag is a usage error, not ignored.
    if (extra.length > 0) {
      process.stderr.write(`engram: model verify: unknown argument '${extra[0]}'\n${USAGE}`);
      return 1;
    }
    return modelVerify();
  }
  process.stderr.write(`engram: unknown 'model' subcommand '${sub ?? ''}'\n${USAGE}`);
  return 1;
}

/**
 * `engram model verify`: resolves and sha256-verifies the configured model (never loading
 * onnxruntime-node if that fails), then loads it and runs a self-similarity sanity check -- the
 * same text embedded twice should cosine-score ~1 (both vectors are L2-normalised, so cosine is
 * just the dot product).
 */
async function modelVerify(): Promise<number> {
  const { embedder, reason } = await tryLoadEmbedder(loadConfig());
  if (!embedder) {
    process.stdout.write(`${reason}\n`);
    return 1;
  }
  const text = 'engram model verify sanity check';
  const [a, b] = await embedder.embed([text, text]);
  const cosine = dot(a, b);
  const ok = Math.abs(cosine - 1) < 1e-4;
  process.stdout.write(
    `ok\nmodel: ${embedder.model}\ndim: ${embedder.dim}\nself-similarity: ${cosine.toFixed(6)}` +
      `${ok ? '' : ' (FAILED: expected ~1)'}\n`,
  );
  return ok ? 0 : 1;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
