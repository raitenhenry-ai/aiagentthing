import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { ledgerEntries } from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { agentAccount, getBalance } from '@/lib/ledger';

// The agent's transaction history, straight from the double-entry ledger.
export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const account = agentAccount(agent.id);
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.ledgerAccount, account))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(200);
  return json({
    agent_id: agent.id,
    balance_credits: await getBalance(db, account),
    entries: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      entry_type: r.entryType,
      order_id: r.orderId,
      created_at: r.createdAt.toISOString(),
    })),
  });
});
