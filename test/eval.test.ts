import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../src/eval/run.js';

/**
 * HANDOFF §11 regression guard.
 *
 * Phase 5 Task 4 (D41, "test/eval.test.ts becomes a regression floor"): §11's recall@5 >= 0.8 targets are NOT met by lexical (FTS5 BM25) retrieval -- see D41 in
 * DECISIONS.md for the full dev/held-out table and the Phase 6 trigger. Asserting the §11 targets
 * here would make this suite red forever until Phase 6 ships, which hides regressions inside an
 * already-failing signal. Instead this is a FLOOR at the honest current dev/gate-none numbers
 * (the recorded `--set dev --gate none` run): single-hop 9/9, temporal >=6/7, update >=5/6,
 * injection 6/6. A drop below the floor is a real regression and this test is supposed to fail; the
 * floor is never lowered to paper over one. §11 targets are not met by lexical retrieval; see D41.
 * Phase 6 restores the target assertions once the hybrid retriever ships.
 */
describe('§11 evaluation suite (dev, gate=none) -- regression floor', () => {
  it('holds the honest dev/gate-none floor: single-hop 9/9, temporal >=6/7, update >=5/6, injection 6/6', async () => {
    const report = await runEvaluation({ set: 'dev', gate: 'none' });

    const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]));
    const detail = report.categories
      .map((c) => `${c.category}: ${c.passed}/${c.total} (${(c.rate * 100).toFixed(1)}%)`)
      .join('\n');
    const failures = report.items
      .filter((i) => !i.pass)
      .map((i) => `  [${i.category}] ${i.id}: ${i.detail}`)
      .join('\n');
    const context = `${detail}${failures ? `\n\nFailing items:\n${failures}` : ''}`;

    expect(byCategory['single-hop']!.passed, context).toBeGreaterThanOrEqual(9);
    expect(byCategory['single-hop']!.total, context).toBe(9);
    expect(byCategory['temporal']!.passed, context).toBeGreaterThanOrEqual(6);
    expect(byCategory['temporal']!.total, context).toBe(7);
    expect(byCategory['update']!.passed, context).toBeGreaterThanOrEqual(5);
    expect(byCategory['update']!.total, context).toBe(6);
    expect(byCategory['injection']!.passed, context).toBeGreaterThanOrEqual(6);
    expect(byCategory['injection']!.total, context).toBe(6);

    // Abstention is reported, not asserted: gate 'none' is arithmetically unable to abstain (D41) --
    // it's an honest, known, documented shortfall, not a thing this floor
    // guards. See D41 in DECISIONS.md.
    const abstention = byCategory['abstention']!;
    console.log(`[eval floor] abstention (reported, not asserted; see D41): ${abstention.passed}/${abstention.total}`);
  });

  // Phase 5 Task 3 fix round 1: the harness must be deterministic -- a fixed `now` and
  // fixed claim `recorded_at`, threaded everywhere, so two runs over the same fixtures produce
  // byte-identical output. IDs (ULIDs) are regenerated per run but never leak into the report; this
  // compares the full serialized report, not just the pass/fail verdict.
  it('is deterministic: two runs produce byte-identical reports', async () => {
    const first = await runEvaluation({ set: 'dev', gate: 'none' });
    const second = await runEvaluation({ set: 'dev', gate: 'none' });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  // Phase 5 Task 4: gates A and B (D40, frozen) are shipped behind the `gate` option but NOT the
  // production default -- this just confirms they still run end-to-end without error on the dev set,
  // and that dev-set abstention (the one place gate A/B measurably help, per the recorded run) stays
  // at or above the recorded 6/6. It does not assert full §11 on gated results (D41: gate A/B both
  // fail §11 on the held-out set and are not adopted in production).
  it.each(['A', 'B'] as const)('gate %s runs on the dev set without error, abstention >= 6/6', async (gate) => {
    const report = await runEvaluation({ set: 'dev', gate });
    const abstention = report.categories.find((c) => c.category === 'abstention')!;
    expect(abstention.total).toBe(6);
    expect(abstention.passed).toBeGreaterThanOrEqual(6);
  });
});
