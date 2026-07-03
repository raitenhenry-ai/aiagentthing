import { z } from 'zod';
import { getDb } from '@/db/client';
import { inngest, isInngestConfigured } from '@/inngest/client';
import { appealDepositFor, openAppeal, resolveAppeal } from '@/lib/appeals';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { topUp } from '@/lib/ledger';
import { getRail, PaymentError } from '@/lib/payments';
import { emitWebhookEvent } from '@/lib/webhooks';

const appealSchema = z.object({
  evidence: z.record(z.string(), z.unknown()),
});

// Seller appeals a FAIL within the 48h window. The 5% deposit is paid via
// x402 exactly like an order (waived for panel-tier verdicts): POST without
// X-PAYMENT → 402 with deposit requirements; retry with X-PAYMENT to file.
// Fresh 5-judge panel, majority final. An appeal is an appeal — never a veto.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, appealSchema);

  const deposit = await appealDepositFor(db, ctx.params.id);
  if (deposit.amountCredits > 0n) {
    const requirements = await getRail().buildRequirements({
      amountCredits: deposit.amountCredits,
      resource: `/api/orders/${ctx.params.id}/appeal`,
      description: `Clearing appeal deposit for order ${ctx.params.id} (refunded if the appeal wins)`,
      extra: { order_id: ctx.params.id, kind: 'appeal_deposit' },
    });
    const paymentHeader = req.headers.get('x-payment');
    if (!paymentHeader) {
      return json(
        {
          x402Version: 1,
          error: 'Appeal deposit payment required (refunded if you win)',
          accepts: [requirements],
        },
        402,
      );
    }
    const settlement = await getRail().settleInbound(paymentHeader, requirements);
    if (settlement.payer !== agent.walletAddress.toLowerCase()) {
      throw new PaymentError('payer_mismatch', 'Payment came from a different wallet');
    }
    // Inbound deposit lands as credits; the state machine holds them.
    await topUp(db, agent.id, deposit.amountCredits, settlement.txHash, ctx.params.id);
  }

  const { disputeId } = await openAppeal(db, {
    orderId: ctx.params.id,
    sellerAgentId: agent.id,
    evidence: body.evidence,
  });
  emitWebhookEvent(db, {
    event: 'order.appealed',
    agentIds: [agent.id],
    payload: { order_id: ctx.params.id, dispute_id: disputeId },
  });

  if (isInngestConfigured()) {
    await inngest.send({ name: 'order/appealed', data: { orderId: ctx.params.id } });
    return json({ dispute_id: disputeId, state: 'appealed', resolution: 'pending' }, 201);
  }
  const { verdict } = await resolveAppeal(db, ctx.params.id);
  return json({ dispute_id: disputeId, state: 'resolved', verdict }, 201);
});
