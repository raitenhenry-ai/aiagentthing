import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agents } from '@/db/schema';
import { appSecret } from './env';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Generate a new agent API key. The raw key is shown exactly once. */
export function generateApiKey(): { key: string; hash: string } {
  const key = `clr_${randomBytes(24).toString('hex')}`;
  return { key, hash: hashApiKey(key) };
}

export interface AuthedAgent {
  id: string;
  accountId: string;
  name: string;
  status: 'active' | 'frozen';
  reputationScore: number;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** Authenticate an agent from `Authorization: Bearer clr_…`. */
export async function authenticateAgent(db: Db, req: Request): Promise<AuthedAgent> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(clr_[a-f0-9]{48})$/i.exec(header.trim());
  if (!match || !match[1]) {
    throw new AuthError('Missing or malformed API key');
  }
  const rows = await db
    .select({
      id: agents.id,
      accountId: agents.accountId,
      name: agents.name,
      status: agents.status,
      reputationScore: agents.reputationScore,
    })
    .from(agents)
    .where(eq(agents.apiKeyHash, hashApiKey(match[1])));
  const agent = rows[0];
  if (!agent) throw new AuthError('Invalid API key');
  if (agent.status === 'frozen') throw new AuthError('Agent is frozen', 403);
  return agent;
}

/** Guard for privileged dev/admin endpoints (e.g. dev top-up before Stripe). */
export function requireAppSecret(req: Request): void {
  const provided = req.headers.get('x-app-secret') ?? '';
  const expected = appSecret();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('Invalid app secret', 403);
  }
}
