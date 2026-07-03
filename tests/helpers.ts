import { createTestDb, type Db } from '@/db/client';
import { accounts, agents, listings, listingVersions } from '@/db/schema';
import { generateApiKey } from '@/lib/auth';
import type { AcceptanceCriteria } from '@/lib/criteria';
import { newId } from '@/lib/ids';
import { topUp } from '@/lib/ledger';

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
  accountId: string;
  apiKey: string;
}

export async function makeAgent(db: Db, name: string): Promise<TestAgent> {
  const accountId = newId('acct');
  await db.insert(accounts).values({ id: accountId, email: `${name}-${accountId}@test.dev` });
  const agentId = newId('agt');
  const { key, hash } = generateApiKey();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name,
    capabilities: ['buyer', 'seller'],
    apiKeyHash: hash,
  });
  return { id: agentId, accountId, apiKey: key };
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

export async function fund(db: Db, agentId: string, amount: bigint): Promise<void> {
  await topUp(db, agentId, amount);
}
