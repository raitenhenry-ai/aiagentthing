import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CriterionResult, Judge, JudgeInput, JudgeVerdict, Verdict } from './judge';
import { buildJudgePrompt } from './prompts';

// Real LLM judges: Anthropic (Claude), OpenAI (GPT), xAI (Grok), all
// behind the common Judge interface. Every provider call has a timeout,
// bounded retries with backoff, and strict JSON parsing of the verdict.

const judgeResponseSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(['PASS', 'FAIL']),
        confidence: z.number().min(0).max(1),
        reasoning: z.string().default(''),
      }),
    )
    .min(1),
  overall_reasoning: z.string().default(''),
});

export interface LlmJudgeOptions {
  /** Fix the rubric wrapper (used by appeal panels for prompt diversity). */
  wrapperIndex?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

type CompleteFn = (prompt: string, signal: AbortSignal) => Promise<string>;

abstract class BaseLlmJudge implements Judge {
  abstract readonly model: string;
  protected abstract complete: CompleteFn;

  constructor(protected readonly opts: LlmJudgeOptions = {}) {}

  async evaluate(input: JudgeInput): Promise<JudgeVerdict> {
    const judged = input.criteria.criteria.filter((c) => c.type === 'judged');
    const { prompt } = buildJudgePrompt({
      judgedCriteria: judged,
      inputPayload: input.inputPayload,
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [input.artifacts],
      receipts: Array.isArray(input.receipts) ? input.receipts : [input.receipts],
      wrapperIndex: this.opts.wrapperIndex,
    });

    const raw = await this.callWithRetry(prompt);
    const parsed = judgeResponseSchema.parse(extractJson(raw));

    const byId = new Map(parsed.criteria.map((c) => [c.id, c]));
    const criteriaResults: CriterionResult[] = judged.map((c) => {
      const r = byId.get(c.id);
      // A criterion the judge failed to address cannot be counted as met.
      if (!r) return { criterionId: c.id, verdict: 'FAIL' as Verdict, confidence: 0.5 };
      return { criterionId: c.id, verdict: r.verdict, confidence: r.confidence };
    });

    const allPass = criteriaResults.every((c) => c.verdict === 'PASS');
    const confidence =
      criteriaResults.reduce((s, c) => s + c.confidence, 0) / Math.max(criteriaResults.length, 1);

    const reasoning = JSON.stringify({
      overall: parsed.overall_reasoning,
      criteria: parsed.criteria.map((c) => ({ id: c.id, reasoning: c.reasoning })),
    });

    return {
      judgeModel: this.model,
      verdict: allPass ? 'PASS' : 'FAIL',
      confidence,
      criteriaResults,
      // Stored hashed only — judge reasoning is never persisted or returned
      // verbatim (it would be a gaming manual for adversarial sellers).
      reasoningHash: createHash('sha256').update(reasoning).digest('hex'),
    };
  }

  private async callWithRetry(prompt: string): Promise<string> {
    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const maxRetries = this.opts.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await this.complete(prompt, controller.signal);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`${this.model} judge failed after ${maxRetries + 1} attempts: ${String(lastError)}`);
  }
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('judge returned no JSON object');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export class AnthropicJudge extends BaseLlmJudge {
  readonly model = process.env.JUDGE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

  protected complete: CompleteFn = async (prompt, signal) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content.find((b) => b.type === 'text')?.text ?? '';
  };
}

export class OpenAiJudge extends BaseLlmJudge {
  readonly model = process.env.JUDGE_OPENAI_MODEL ?? 'gpt-4o';

  protected complete: CompleteFn = async (prompt, signal) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message.content ?? '';
  };
}

export class GrokJudge extends BaseLlmJudge {
  readonly model = process.env.JUDGE_XAI_MODEL ?? 'grok-4';

  // xAI's API is OpenAI-compatible chat completions.
  protected complete: CompleteFn = async (prompt, signal) => {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.XAI_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`grok ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message.content ?? '';
  };
}

/**
 * The production judge: OpenAI (GPT). Returns [] when OPENAI_API_KEY is
 * absent so the caller substitutes the dev stub (or, for judged criteria,
 * fails closed).
 */
export function realJudges(opts: LlmJudgeOptions = {}): Judge[] {
  // OpenAI (GPT) is the sole verification judge. AnthropicJudge / GrokJudge
  // remain available above if you ever want to reinstate a multi-provider
  // panel — wire them back into this function to do so.
  return process.env.OPENAI_API_KEY ? [new OpenAiJudge(opts)] : [];
}
