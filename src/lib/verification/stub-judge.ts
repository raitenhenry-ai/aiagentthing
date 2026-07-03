import { createHash } from 'node:crypto';
import type { Judge, JudgeInput, JudgeVerdict } from './judge';

/**
 * Phase 1 stand-in for the real panel: PASSes everything with confidence 1.0
 * so the full order loop runs end-to-end. Replaced by Claude/GPT/Gemini
 * judges in Phase 2. Construct with `verdict: 'FAIL'` in tests to exercise
 * the FAIL / override / refund paths.
 */
export class StubJudge implements Judge {
  readonly model: string;
  private readonly verdict: 'PASS' | 'FAIL';
  private readonly confidence: number;

  constructor(opts?: { model?: string; verdict?: 'PASS' | 'FAIL'; confidence?: number }) {
    this.model = opts?.model ?? 'stub-judge-v1';
    this.verdict = opts?.verdict ?? 'PASS';
    this.confidence = opts?.confidence ?? 1.0;
  }

  async evaluate(input: JudgeInput): Promise<JudgeVerdict> {
    const reasoning = `stub verdict ${this.verdict} for all ${input.criteria.criteria.length} criteria`;
    return {
      judgeModel: this.model,
      verdict: this.verdict,
      confidence: this.confidence,
      criteriaResults: input.criteria.criteria.map((c) => ({
        criterionId: c.id,
        verdict: this.verdict,
        confidence: this.confidence,
      })),
      reasoningHash: createHash('sha256').update(reasoning).digest('hex'),
    };
  }
}
