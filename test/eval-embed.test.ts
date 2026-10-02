import { afterEach, describe, expect, it } from 'vitest';
import { createFakeEmbedder } from '../src/embed/fake.js';
import { runEvaluation } from '../src/eval/run.js';

/**
 * Phase 6 Task 3 (D42/hybrid): `--embed` support in the eval harness. These tests use
 * `embedderOverride` (the fake embedder) so they're deterministic and never require a real ONNX
 * model file on disk -- the real-model tau sweep itself is a one-off, reported in the task report,
 * not re-run by this suite (see test/embed-onnx-real.test.ts for the project's existing
 * skip-without-env-vars convention for anything that genuinely needs the real model).
 */
describe('eval --embed', () => {
  let prevDir: string | undefined;
  let prevSha: string | undefined;
  let touchedEnv = false;

  // Only restore when a test actually changed the env -- otherwise this would wipe a real
  // ENGRAM_EMBED_MODEL_DIR/_SHA256 after every test and break the real-model floor below.
  afterEach(() => {
    if (!touchedEnv) return;
    touchedEnv = false;
    if (prevDir === undefined) delete process.env.ENGRAM_EMBED_MODEL_DIR;
    else process.env.ENGRAM_EMBED_MODEL_DIR = prevDir;
    if (prevSha === undefined) delete process.env.ENGRAM_EMBED_MODEL_SHA256;
    else process.env.ENGRAM_EMBED_MODEL_SHA256 = prevSha;
    prevDir = undefined;
    prevSha = undefined;
  });

  it('with embed but no ENGRAM_EMBED_MODEL_DIR/_SHA256 and no override, errors clearly', async () => {
    prevDir = process.env.ENGRAM_EMBED_MODEL_DIR;
    prevSha = process.env.ENGRAM_EMBED_MODEL_SHA256;
    touchedEnv = true;
    delete process.env.ENGRAM_EMBED_MODEL_DIR;
    delete process.env.ENGRAM_EMBED_MODEL_SHA256;

    await expect(runEvaluation({ set: 'dev', embed: true })).rejects.toThrow(/ENGRAM_EMBED_MODEL_DIR/);
  });

  it('runs end-to-end with a fake embedder override, embedding the seeded corpus and producing the usual report shape', async () => {
    const report = await runEvaluation({ set: 'dev', embed: true, tau: 0.45, embedderOverride: createFakeEmbedder() });
    expect(report.categories.map((c) => c.category)).toEqual(['single-hop', 'temporal', 'update', 'abstention', 'injection']);
    expect(report.items.length).toBeGreaterThan(0);
    // Fixed `now` + fixed `recorded_at` still hold under --embed: every item has a deterministic shape.
    for (const item of report.items) {
      expect(typeof item.pass).toBe('boolean');
    }
  });

  it('is deterministic under --embed: two runs with the same fake embedder produce byte-identical reports', async () => {
    const first = await runEvaluation({ set: 'dev', embed: true, tau: 0.45, embedderOverride: createFakeEmbedder() });
    const second = await runEvaluation({ set: 'dev', embed: true, tau: 0.45, embedderOverride: createFakeEmbedder() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('runs cleanly at both ends of the pre-registered tau sweep range (0.30 and 0.55) with no crash', async () => {
    const low = await runEvaluation({ set: 'dev', embed: true, tau: 0.3, embedderOverride: createFakeEmbedder() });
    const high = await runEvaluation({ set: 'dev', embed: true, tau: 0.55, embedderOverride: createFakeEmbedder() });
    expect(low.overallPass).toBeTypeOf('boolean');
    expect(high.overallPass).toBeTypeOf('boolean');
  });

  it('non-embed runs are completely unaffected by the embed plumbing (embed defaults to false)', async () => {
    const report = await runEvaluation({ set: 'dev', gate: 'none' });
    expect(report.categories.find((c) => c.category === 'single-hop')!.total).toBe(9);
  });
});

/**
 * Phase 6 Task 4 (D44): regression floor for the REAL hybrid path at the frozen τ = 0.45 (D43), on the
 * dev set. Held-out-2 showed hybrid misses §11 (D44), so per the pre-registered rule the §11 targets
 * are NOT asserted here -- like test/eval.test.ts's lexical floor, this pins the honest dev numbers
 * recorded in D43 (single-hop 9/9, temporal 5/7, update 6/6, abstention 5/6, injection 6/6) so a drop
 * fails the suite. The floor is never lowered to paper over a regression. Skipped without the model.
 */
const hasModel = Boolean(process.env.ENGRAM_EMBED_MODEL_DIR && process.env.ENGRAM_EMBED_MODEL_SHA256);
describe.skipIf(!hasModel)('eval --embed (real model, dev, τ = 0.45) -- regression floor (D43/D44)', () => {
  it('holds the D43 dev floor', async () => {
    const report = await runEvaluation({ set: 'dev', embed: true, tau: 0.45 });
    const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    const context = report.items
      .filter((i) => !i.pass)
      .map((i) => `  [${i.category}] ${i.id}: ${i.detail}`)
      .join('\n');
    const floor: Record<string, [number, number]> = {
      'single-hop': [9, 9],
      temporal: [5, 7],
      update: [6, 6],
      abstention: [5, 6],
      injection: [6, 6],
    };
    for (const [category, [min, total]] of Object.entries(floor)) {
      expect(byCategory[category]!.total, `${category}\n${context}`).toBe(total);
      expect(byCategory[category]!.passed, `${category}\n${context}`).toBeGreaterThanOrEqual(min);
    }
  }, 120_000);
});
