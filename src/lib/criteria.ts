import { z } from 'zod';

// The acceptance-criteria contract stored on every listing version. `schema`
// and `programmatic` criteria are machine-checked (free, deterministic);
// only `judged` criteria reach the LLM panel (Phase 2).

export const criterionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('schema'),
    spec: z.object({ json_schema: z.record(z.string(), z.unknown()) }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('programmatic'),
    spec: z.object({
      check: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('judged'),
    spec: z.object({
      requirement: z.string().min(1),
      rubric: z.string().optional(),
    }),
  }),
]);

export const acceptanceCriteriaSchema = z
  .object({
    criteria: z.array(criterionSchema).min(1),
    pass_rule: z
      .union([z.literal('all'), z.string().regex(/^weighted:0?\.\d+$/)])
      .default('all'),
  })
  .refine(
    (v) => new Set(v.criteria.map((c) => c.id)).size === v.criteria.length,
    { message: 'criterion ids must be unique' },
  );

export type AcceptanceCriteria = z.infer<typeof acceptanceCriteriaSchema>;
export type Criterion = z.infer<typeof criterionSchema>;

/** Zero machine-checkable criteria → "low verifiability", always panel tier. */
export function isLowVerifiability(c: AcceptanceCriteria): boolean {
  return c.criteria.every((criterion) => criterion.type === 'judged');
}
