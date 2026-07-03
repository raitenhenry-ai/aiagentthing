import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { verifyMessage } from 'viem';
import type { Db } from '@/db/client';
import { agents, authNonces, sessions } from '@/db/schema';
import { appSecret } from './env';
import { newId } from './ids';
import { checkRateLimit, rateLimitFor } from './rate-limit';

// Identity = wallet. An agent authenticates by signing a one-time challenge
// with its Base wallet key (SIWE-style) and receives a bearer session token.
// The agent record is auto-created on first successful verification — no
// signup, no emails, no API keys.

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const NONCE_TTL_SECONDS = 10 * 60;

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export function normalizeWallet(address: string): string {
  if (!WALLET_RE.test(address)) throw new AuthError('Invalid wallet address', 422);
  return address.toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Step 1: issue a single-use challenge for the wallet to sign. */
export async function createChallenge(
  db: Db,
  walletAddress: string,
): Promise<{ nonce: string; message: string; expiresAt: Date }> {
  const wallet = normalizeWallet(walletAddress);
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000);
  await db.insert(authNonces).values({ nonce, walletAddress: wallet, expiresAt });
  return { nonce, message: challengeMessage(wallet, nonce), expiresAt };
}

export function challengeMessage(wallet: string, nonce: string): string {
  return `Clearing wants you to sign in with your wallet:\n${wallet}\n\nNonce: ${nonce}`;
}

/**
 * Step 2: verify the signature over the challenge, burn the nonce, auto-
 * create the agent if this wallet is new, and mint a session token (returned
 * once; stored hashed).
 */
export async function verifyChallenge(
  db: Db,
  args: { walletAddress: string; nonce: string; signature: `0x${string}`; name?: string },
): Promise<{ agentId: string; walletAddress: string; sessionToken: string; expiresAt: Date }> {
  const wallet = normalizeWallet(args.walletAddress);

  const nonceRows = await db
    .delete(authNonces)
    .where(
      and(
        eq(authNonces.nonce, args.nonce),
        eq(authNonces.walletAddress, wallet),
        gt(authNonces.expiresAt, new Date()),
      ),
    )
    .returning({ nonce: authNonces.nonce });
  if (!nonceRows[0]) throw new AuthError('Unknown or expired challenge nonce');

  const valid = await verifyMessage({
    address: args.walletAddress as `0x${string}`,
    message: challengeMessage(wallet, args.nonce),
    signature: args.signature,
  }).catch(() => false);
  if (!valid) throw new AuthError('Signature verification failed');

  // Auto-create on first interaction; the wallet IS the identity.
  let agentRows = await db.select().from(agents).where(eq(agents.walletAddress, wallet));
  let agent = agentRows[0];
  if (!agent) {
    const inserted = await db
      .insert(agents)
      .values({
        id: newId('agt'),
        walletAddress: wallet,
        name: args.name ?? `agent-${wallet.slice(2, 8)}`,
        capabilities: ['buyer', 'seller'],
      })
      .onConflictDoNothing({ target: agents.walletAddress })
      .returning();
    agent = inserted[0] ?? (await db.select().from(agents).where(eq(agents.walletAddress, wallet)))[0];
  }
  if (!agent) throw new AuthError('Agent creation failed', 500);
  if (agent.status === 'frozen') throw new AuthError('Agent is frozen', 403);

  const sessionToken = `clr_sess_${randomBytes(24).toString('hex')}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({
    tokenHash: hashToken(sessionToken),
    agentId: agent.id,
    expiresAt,
  });
  return { agentId: agent.id, walletAddress: wallet, sessionToken, expiresAt };
}

/** Mint a session directly (internal/test use — bypasses signature check). */
export async function mintSession(db: Db, agentId: string): Promise<string> {
  const sessionToken = `clr_sess_${randomBytes(24).toString('hex')}`;
  await db.insert(sessions).values({
    tokenHash: hashToken(sessionToken),
    agentId,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  return sessionToken;
}

export interface AuthedAgent {
  id: string;
  walletAddress: string;
  name: string;
  status: 'active' | 'frozen';
  reputationScore: number;
}

/** Authenticate a request from `Authorization: Bearer clr_sess_…`. */
export async function authenticateAgent(db: Db, req: Request): Promise<AuthedAgent> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(clr_sess_[a-f0-9]{48})$/i.exec(header.trim());
  if (!match || !match[1]) {
    throw new AuthError('Missing or malformed session token');
  }
  const rows = await db
    .select({
      id: agents.id,
      walletAddress: agents.walletAddress,
      name: agents.name,
      status: agents.status,
      reputationScore: agents.reputationScore,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(eq(sessions.tokenHash, hashToken(match[1])));
  const row = rows[0];
  if (!row) throw new AuthError('Invalid session token');
  if (row.expiresAt < new Date()) throw new AuthError('Session expired');
  if (row.status === 'frozen') throw new AuthError('Agent is frozen', 403);
  // Per-agent limits, tiered by reputation: capacity compounds with trust.
  checkRateLimit(row.id, rateLimitFor(row.reputationScore));
  return {
    id: row.id,
    walletAddress: row.walletAddress,
    name: row.name,
    status: row.status,
    reputationScore: row.reputationScore,
  };
}

/** Guard for privileged admin/ops endpoints. */
export function requireAppSecret(req: Request): void {
  const provided = req.headers.get('x-app-secret') ?? '';
  const expected = appSecret();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('Invalid app secret', 403);
  }
}
