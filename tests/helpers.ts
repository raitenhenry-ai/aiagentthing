import { randomBytes } from 'node:crypto';
import { createTestDb, type Db } from '@/db/client';
import { agents, listings, listingVersions } from '@/db/schema';
import { mintSession } from '@/lib/auth';
import type { AcceptanceCriteria } from '@/lib/criteria';
import { newId } from '@/lib/ids';
import { topUp } from '@/lib/ledger';
import { createOrderQuote, payForOrder } from '@/lib/orders';
import { getMockRail } from '@/lib/payments';
import { MockRail } from '@/lib/payments/mock-rail';

export { createTestDb };

export const TEST_CRITERIA: AcceptanceCriteria = {
  criteria: [
    {
      id: 'c1',
      type: 'schema',
      spec: { json_schema: { type: 'object', required: ['summary'] } },
    },
    {
      id: 'c2',
      type: 'judged',
      spec: { requirement: 'Summary covers all sections of the input doc' },
    },
  ],
  pass_rule: 'all',
};

export interface TestAgent {
  id: string;
  wallet: string;
  sessionToken: string;
}

export function randomWallet(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

export async function makeAgent(db: Db, name: string): Promise<TestAgent> {
  const agentId = newId('agt');
  const wallet = randomWallet();
  await db.insert(agents).values({
    id: agentId,
    walletAddress: wallet,
    name,
    capabilities: ['buyer', 'seller'],
  });
  const sessionToken = await mintSession(db, agentId);
  return { id: agentId, wallet, sessionToken };
}

export async function makeListing(
  db: Db,
  sellerAgentId: string,
  opts?: { priceCredits?: bigint; turnaroundSeconds?: number },
): Promise<string> {
  const id = newId('lst');
  const priceCredits = opts?.priceCredits ?? 1000n;
  const turnaroundSeconds = opts?.turnaroundSeconds ?? 3600;
  await db.insert(listings).values({
    id,
    sellerAgentId,
    title: 'Test service',
    description: 'A test service',
    priceCredits,
    turnaroundSeconds,
    acceptanceCriteria: TEST_CRITERIA,
    status: 'active',
    version: 1,
  });
  await db.insert(listingVersions).values({
    listingId: id,
    version: 1,
    priceCredits,
    turnaroundSeconds,
    acceptanceCriteria: TEST_CRITERIA,
  });
  return id;
}

/** Ledger-only funding (no chain): for unit tests below the payments layer. */
export async function fund(db: Db, agentId: string, amount: bigint): Promise<void> {
  await topUp(db, agentId, amount);
}

/** Put mock USDC in a wallet on the mock chain. */
export function fundWallet(wallet: string, credits: bigint): void {
  getMockRail().fund(wallet, credits);
}

/**
 * Full x402 purchase: quote → fund buyer wallet on the mock chain → pay →
 * escrowed order. This is the same path the REST/MCP surface drives.
 */
export async function makeEscrowedOrder(
  db: Db,
  buyer: TestAgent,
  listingId: string,
  inputPayload: unknown = { doc: 'hello' },
): Promise<string> {
  const quote = await createOrderQuote(db, {
    buyerAgentId: buyer.id,
    listingId,
    inputPayload,
  });
  fundWallet(buyer.wallet, quote.priceCredits);
  await payForOrder(db, {
    orderId: quote.orderId,
    buyerAgentId: buyer.id,
    buyerWallet: buyer.wallet,
    paymentHeader: MockRail.paymentHeader(buyer.wallet),
  });
  return quote.orderId;
}
