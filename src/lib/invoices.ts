import { desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { agents, invoices } from '@/db/schema';
import { ApiError } from './http';
import { newId } from './ids';
import { agentAccount, feeFor, PLATFORM_FEES, postMovement, topUp } from './ledger';
import { getRail } from './payments';
import { settleInboundIdempotent } from './payments/inbound';
import { executePayout, enqueuePayout } from './payments/payouts';
import { PaymentError, type PaymentRequirements } from './payments/rail';
import { emitWebhookEvent } from './webhooks';

// Direct invoicing between agents: custom/off-listing work, retainers,
// post-hoc billing. Paid via the exact same x402 flow; the platform fee
// applies; funds pay out to the seller's wallet immediately (no escrow, no
// judge panel — counterparty risk is priced via reputation + reviews).

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  amount_credits: z.number().int().positive().max(100_000_000),
});

export const invoiceLineItemsSchema = z.array(lineItemSchema).min(1).max(50);

function invoiceFeeBps(): number {
  const raw = process.env.INVOICE_FEE_BPS ?? process.env.PLATFORM_FEE_BPS ?? '1000';
  return Number.parseInt(raw, 10);
}

export async function createInvoice(
  db: Db,
  args: {
    sellerAgentId: string;
    buyerAgentId: string;
    lineItems: Array<{ description: string; amount_credits: number }>;
    memo?: string;
    dueAt?: Date;
  },
): Promise<{ invoiceId: string; amountCredits: bigint }> {
  if (args.buyerAgentId === args.sellerAgentId) {
    throw new ApiError('self_dealing', 'An agent cannot invoice itself', 409);
  }
  const buyerRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, args.buyerAgentId));
  if (!buyerRows[0]) throw new ApiError('not_found', 'Billed agent not found', 404);

  const items = invoiceLineItemsSchema.parse(args.lineItems);
  const amountCredits = items.reduce((sum, i) => sum + BigInt(i.amount_credits), 0n);
  if (amountCredits > 100_000_000n) {
    throw new ApiError('invalid_amount', 'Invoice total exceeds the cap', 422);
  }

  const invoiceId = newId('inv');
  await db.insert(invoices).values({
    id: invoiceId,
    sellerAgentId: args.sellerAgentId,
    buyerAgentId: args.buyerAgentId,
    lineItems: items,
    amountCredits,
    memo: args.memo ?? '',
    dueAt: args.dueAt,
  });
  emitWebhookEvent(db, {
    event: 'invoice.created',
    agentIds: [args.buyerAgentId],
    payload: { invoice_id: invoiceId, amount_credits: Number(amountCredits) },
  });
  return { invoiceId, amountCredits };
}

export async function invoiceRequirements(
  db: Db,
  invoiceId: string,
): Promise<PaymentRequirements> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  const invoice = rows[0];
  if (!invoice) throw new ApiError('not_found', 'Invoice not found', 404);
  if (invoice.status !== 'open') throw new ApiError('bad_state', `Invoice is ${invoice.status}`, 409);
  return getRail().buildRequirements({
    amountCredits: invoice.amountCredits,
    resource: `/api/invoices/${invoice.id}/pay`,
    description: `Clearing invoice ${invoice.id}: ${invoice.memo || 'services'}`,
    extra: { invoice_id: invoice.id, kind: 'invoice' },
  });
}

/** Pay an open invoice via x402 — idempotent per payment header. */
export async function payInvoice(
  db: Db,
  args: {
    invoiceId: string;
    buyerAgentId: string;
    buyerWallet: string;
    paymentHeader: string;
  },
): Promise<{ invoiceId: string; txHash: string; netToSeller: bigint; fee: bigint }> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, args.invoiceId));
  const invoice = rows[0];
  if (!invoice || invoice.buyerAgentId !== args.buyerAgentId) {
    throw new ApiError('not_found', 'Invoice not found', 404);
  }
  if (invoice.status === 'paid') throw new ApiError('already_paid', 'Invoice already paid', 409);
  if (invoice.status !== 'open') throw new ApiError('bad_state', `Invoice is ${invoice.status}`, 409);
  if (invoice.dueAt && invoice.dueAt < new Date()) {
    throw new ApiError('expired', 'Invoice is past due — ask the seller to reissue', 409);
  }

  const requirements = await invoiceRequirements(db, invoice.id);
  const settlement = await settleInboundIdempotent(db, {
    paymentHeader: args.paymentHeader,
    requirements,
    agentId: args.buyerAgentId,
    context: `invoice:${invoice.id}`,
  });
  if (settlement.payer !== args.buyerWallet.toLowerCase()) {
    throw new PaymentError('payer_mismatch', 'Payment came from a different wallet');
  }

  const sellerRows = await db
    .select({ wallet: agents.walletAddress })
    .from(agents)
    .where(eq(agents.id, invoice.sellerAgentId));
  const sellerWallet = sellerRows[0]?.wallet;
  if (!sellerWallet) throw new ApiError('not_found', 'Seller not found', 404);

  const fee = feeFor(invoice.amountCredits, invoiceFeeBps());
  const net = invoice.amountCredits - fee;

  let payoutId: string | undefined;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .for('update');
    if (locked[0]?.status !== 'open') return; // concurrent payer finalized
    await topUp(tx, args.buyerAgentId, invoice.amountCredits, settlement.txHash);
    await postMovement(tx, {
      from: agentAccount(args.buyerAgentId),
      to: agentAccount(invoice.sellerAgentId),
      amount: net,
      entryType: 'invoice_payment',
    });
    if (fee > 0n) {
      await postMovement(tx, {
        from: agentAccount(args.buyerAgentId),
        to: PLATFORM_FEES,
        amount: fee,
        entryType: 'fee',
      });
    }
    payoutId = await enqueuePayout(tx, {
      agentId: invoice.sellerAgentId,
      toWallet: sellerWallet,
      amountCredits: net,
      reason: 'invoice',
    });
    await tx
      .update(invoices)
      .set({ status: 'paid', paidAt: new Date(), txHash: settlement.txHash })
      .where(eq(invoices.id, invoice.id));
  });

  // Post-commit: execute the seller payout (retried by the worker on failure).
  if (payoutId) await executePayout(db, payoutId).catch(() => undefined);

  emitWebhookEvent(db, {
    event: 'invoice.paid',
    agentIds: [invoice.sellerAgentId, args.buyerAgentId],
    payload: { invoice_id: invoice.id, tx_hash: settlement.txHash },
  });
  return { invoiceId: invoice.id, txHash: settlement.txHash, netToSeller: net, fee };
}

export async function voidInvoice(
  db: Db,
  args: { invoiceId: string; sellerAgentId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(invoices).where(eq(invoices.id, args.invoiceId)).for('update');
    const invoice = rows[0];
    if (!invoice || invoice.sellerAgentId !== args.sellerAgentId) {
      throw new ApiError('not_found', 'Invoice not found', 404);
    }
    if (invoice.status !== 'open') throw new ApiError('bad_state', `Invoice is ${invoice.status}`, 409);
    await tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoice.id));
  });
}

export async function listInvoices(db: Db, agentId: string) {
  const rows = await db
    .select()
    .from(invoices)
    .where(or(eq(invoices.sellerAgentId, agentId), eq(invoices.buyerAgentId, agentId)))
    .orderBy(desc(invoices.createdAt))
    .limit(100);
  return rows.map((i) => ({
    id: i.id,
    role: i.sellerAgentId === agentId ? 'seller' : 'buyer',
    seller_agent_id: i.sellerAgentId,
    buyer_agent_id: i.buyerAgentId,
    line_items: i.lineItems,
    amount_credits: i.amountCredits,
    memo: i.memo,
    status: i.status,
    due_at: i.dueAt?.toISOString() ?? null,
    tx_hash: i.txHash,
    created_at: i.createdAt.toISOString(),
    paid_at: i.paidAt?.toISOString() ?? null,
  }));
}
