import type { AcceptanceCriteria } from '../criteria';

// Common interface every judge implements — the Phase 2 Claude/GPT/Gemini
// panel judges plug in behind this exact shape, as does the Phase 1 stub.

export type Verdict = 'PASS' | 'FAIL';

export interface JudgeInput {
  criteria: AcceptanceCriteria;
  /** The buyer's order input. */
  inputPayload: unknown;
  /** Deliverable artifacts (blob refs / inline in Phase 1). */
  artifacts: unknown;
  /** Seller's structured proof-of-work log. */
  receipts: unknown;
}

export interface CriterionResult {
  criterionId: string;
  verdict: Verdict;
  confidence: number; // 0-1
}

export interface JudgeVerdict {
  judgeModel: string;
  verdict: Verdict;
  confidence: number; // 0-1
  criteriaResults: CriterionResult[];
  /**
   * SHA-256 of the judge's reasoning. Reasoning is stored hashed and never
   * returned to sellers — verbatim reasoning is a gaming manual.
   */
  reasoningHash: string;
}

export interface Judge {
  readonly model: string;
  evaluate(input: JudgeInput): Promise<JudgeVerdict>;
}

export interface AggregateResult {
  verdict: Verdict;
  confidence: number;
  tier: 'auto' | 'panel' | 'dispute';
  verdicts: JudgeVerdict[];
}

/**
 * Aggregate panel verdicts. Unanimous with average confidence >= 0.8 →
 * `auto` tier. Anything else (splits, low confidence) → `panel` tier:
 * majority verdict stands but is flagged appealable at no fee. (Phase 2 adds
 * the fresh-sampling re-run before landing on `panel`.)
 */
export function aggregateVerdicts(verdicts: JudgeVerdict[]): AggregateResult {
  if (verdicts.length === 0) throw new Error('Cannot aggregate zero verdicts');
  const passes = verdicts.filter((v) => v.verdict === 'PASS').length;
  // Panels are odd-sized (1, 3, 5) so strict majority always exists; a
  // hypothetical tie resolves to FAIL (funds stay refundable, seller keeps
  // the free appeal path).
  const majority: Verdict = passes * 2 > verdicts.length ? 'PASS' : 'FAIL';
  const confidence =
    verdicts.reduce((sum, v) => sum + v.confidence, 0) / verdicts.length;
  const unanimous = passes === 0 || passes === verdicts.length;
  const tier = unanimous && confidence >= 0.8 ? 'auto' : 'panel';
  return { verdict: majority, confidence, tier, verdicts };
}
