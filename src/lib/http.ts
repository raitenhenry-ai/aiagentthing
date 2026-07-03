import { z } from 'zod';
import { AuthError } from './auth';
import { InsufficientFundsError, LedgerError } from './ledger';
import { TransitionError } from './state-machine';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** JSON response that serializes bigint credits as numbers. */
export function json(data: unknown, status = 200): Response {
  const body = JSON.stringify(data, (_key, value: unknown) =>
    typeof value === 'bigint' ? Number(value) : value,
  );
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('invalid_json', 'Request body must be valid JSON', 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('validation_error', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
  }
  return parsed.data;
}

/** Wrap a route handler with uniform domain-error → HTTP mapping. */
export function route<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e.code, e.message, e.status);
      if (e instanceof AuthError) return errorResponse('unauthorized', e.message, e.status);
      if (e instanceof InsufficientFundsError) {
        return errorResponse('insufficient_funds', e.message, 402);
      }
      if (e instanceof TransitionError) {
        const status = e.code === 'forbidden_actor' ? 403 : 409;
        return errorResponse(e.code, e.message, status);
      }
      if (e instanceof LedgerError) return errorResponse('ledger_error', e.message, 409);
      console.error('Unhandled API error:', e);
      return errorResponse('internal_error', 'Internal server error', 500);
    }
  };
}
