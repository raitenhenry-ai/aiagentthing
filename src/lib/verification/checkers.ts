import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Criterion } from '../criteria';

// Machine-checkable criteria: deterministic, free, run before any LLM judge.
// `schema` criteria validate the deliverable payload against a JSON Schema;
// `programmatic` criteria run a named check from the whitelist below — never
// arbitrary code, no eval, no sandbox escapes.

export interface CheckContext {
  /** Primary deliverable payload: artifacts[0].inline (MVP convention). */
  payload: unknown;
  artifacts: unknown[];
  receipts: unknown[];
  inputPayload: unknown;
  /** Injectable for tests / offline; defaults to global fetch. */
  fetcher?: typeof fetch;
}

export interface CheckResult {
  criterionId: string;
  verdict: 'PASS' | 'FAIL';
  confidence: number; // deterministic checks are always 1
  detail: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function extractUrls(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return [...new Set(text.match(/https?:\/\/[^\s"'<>\\)\]]+/g) ?? [])];
}

type ProgrammaticCheck = (
  params: Record<string, unknown>,
  ctx: CheckContext,
) => Promise<{ pass: boolean; detail: string }>;

const SAFE_REGEX_FLAGS = /^[imsu]{0,4}$/;

/** The whitelist. Adding a check means adding a named, reviewed function. */
const PROGRAMMATIC_CHECKS: Record<string, ProgrammaticCheck> = {
  async field_present(params, ctx) {
    const fields = Array.isArray(params.fields) ? (params.fields as string[]) : [];
    const missing = fields.filter((f) => getPath(ctx.payload, f) === undefined);
    return {
      pass: missing.length === 0,
      detail: missing.length ? `missing fields: ${missing.join(', ')}` : 'all fields present',
    };
  },

  async regex_match(params, ctx) {
    const pattern = String(params.pattern ?? '');
    const flags = String(params.flags ?? '');
    if (pattern.length === 0 || pattern.length > 500) {
      return { pass: false, detail: 'invalid pattern length' };
    }
    if (!SAFE_REGEX_FLAGS.test(flags)) {
      return { pass: false, detail: 'invalid regex flags' };
    }
    const target = getPath(ctx.payload, params.field as string | undefined);
    const text = typeof target === 'string' ? target : JSON.stringify(target ?? '');
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      return { pass: false, detail: 'pattern failed to compile' };
    }
    const pass = re.test(text);
    return { pass, detail: pass ? 'pattern matched' : 'pattern did not match' };
  },

  async json_parsable(params, ctx) {
    const target = getPath(ctx.payload, params.field as string | undefined);
    if (typeof target !== 'string') {
      return { pass: false, detail: 'target is not a string' };
    }
    try {
      JSON.parse(target);
      return { pass: true, detail: 'valid JSON' };
    } catch (e) {
      return { pass: false, detail: `JSON parse failed: ${(e as Error).message}` };
    }
  },

  async csv_parsable(params, ctx) {
    const target = getPath(ctx.payload, params.field as string | undefined);
    if (typeof target !== 'string' || target.trim() === '') {
      return { pass: false, detail: 'target is not a non-empty string' };
    }
    const lines = target.trim().split(/\r?\n/);
    const width = (lines[0] ?? '').split(',').length;
    const ragged = lines.findIndex((l) => l.split(',').length !== width);
    return ragged === -1
      ? { pass: true, detail: `csv with ${lines.length} rows × ${width} cols` }
      : { pass: false, detail: `row ${ragged + 1} has inconsistent column count` };
  },

  async all_urls_resolve(params, ctx) {
    const target = getPath(ctx.payload, params.field as string | undefined);
    const urls = extractUrls(target).slice(0, 20);
    if (urls.length === 0) return { pass: true, detail: 'no urls found' };
    const fetcher = ctx.fetcher ?? fetch;
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const res = await fetcher(url, { method: 'HEAD', signal: controller.signal });
          clearTimeout(timer);
          return { url, ok: res.ok };
        } catch {
          return { url, ok: false };
        }
      }),
    );
    const dead = results.filter((r) => !r.ok).map((r) => r.url);
    return {
      pass: dead.length === 0,
      detail: dead.length ? `unresolvable urls: ${dead.join(', ')}` : `${urls.length} urls resolve`,
    };
  },
};

export function isKnownCheck(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROGRAMMATIC_CHECKS, name);
}

/** Run one machine-checkable criterion. Judged criteria are not handled here. */
export async function runMachineCriterion(
  criterion: Criterion,
  ctx: CheckContext,
): Promise<CheckResult> {
  if (criterion.type === 'schema') {
    let validate;
    try {
      validate = ajv.compile(criterion.spec.json_schema);
    } catch (e) {
      return {
        criterionId: criterion.id,
        verdict: 'FAIL',
        confidence: 1,
        detail: `criterion schema invalid: ${(e as Error).message}`,
      };
    }
    const pass = validate(ctx.payload) as boolean;
    return {
      criterionId: criterion.id,
      verdict: pass ? 'PASS' : 'FAIL',
      confidence: 1,
      detail: pass
        ? 'schema valid'
        : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; '),
    };
  }
  if (criterion.type === 'programmatic') {
    const check = PROGRAMMATIC_CHECKS[criterion.spec.check];
    if (!check) {
      return {
        criterionId: criterion.id,
        verdict: 'FAIL',
        confidence: 1,
        detail: `unknown programmatic check: ${criterion.spec.check}`,
      };
    }
    const { pass, detail } = await check(criterion.spec.params ?? {}, ctx);
    return { criterionId: criterion.id, verdict: pass ? 'PASS' : 'FAIL', confidence: 1, detail };
  }
  throw new Error(`Criterion ${criterion.id} is not machine-checkable`);
}
