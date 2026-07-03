import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { voidInvoice } from '@/lib/invoices';

export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  await voidInvoice(db, { invoiceId: ctx.params.id, sellerAgentId: agent.id });
  return json({ id: ctx.params.id, status: 'void' });
});
