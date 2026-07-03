import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { agentAccount, getBalance } from '@/lib/ledger';

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const balance = await getBalance(db, agentAccount(agent.id));
  return json({ agent_id: agent.id, balance_credits: balance });
});
