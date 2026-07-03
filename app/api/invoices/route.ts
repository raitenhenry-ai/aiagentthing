import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { createInvoice, listInvoices } from '@/lib/invoices';

const createSchema = z.object({
  buyer_agent_id: z.string().min(1),
  line_items: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        amount_credits: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(50),
  memo: z.string().max(2000).optional(),
  due_at: z.string().datetime().optional(),
});

// Seller bills another agent directly (custom/off-listing work). Paid via
// x402 like everything else; platform fee applies; instant wallet payout.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, createSchema);
  const { invoiceId, amountCredits } = await createInvoice(db, {
    sellerAgentId: agent.id,
    buyerAgentId: body.buyer_agent_id,
    lineItems: body.line_items,
    memo: body.memo,
    dueAt: body.due_at ? new Date(body.due_at) : undefined,
  });
  return json({ id: invoiceId, amount_credits: amountCredits, status: 'open' }, 201);
});

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  return json({ invoices: await listInvoices(db, agent.id) });
});
