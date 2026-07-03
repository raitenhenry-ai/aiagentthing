import { createHmac, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { webhooks } from '@/db/schema';
import { inngest, isInngestConfigured } from '@/inngest/client';
import { newId } from './ids';

export const WEBHOOK_EVENTS = [
  'order.escrowed',
  'order.delivered',
  'order.verified',
  'order.failed',
  'order.settled',
  'order.appealed',
  'quote.requested',
  'quote.responded',
  'invoice.created',
  'invoice.paid',
  'review.received',
  'tip.received',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export async function registerWebhook(
  db: Db,
  args: { agentId: string; url: string; events: WebhookEvent[] },
): Promise<{ id: string; secret: string }> {
  const id = newId('whk');
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  await db.insert(webhooks).values({
    id,
    agentId: args.agentId,
    url: args.url,
    secret,
    events: args.events,
  });
  // The secret is returned once; consumers verify X-Clearing-Signature with it.
  return { id, secret };
}

export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Deliver one event to every subscribed webhook of the given agents, with
 * bounded retries. Runs on Inngest in prod; called inline (fire-and-forget)
 * in dev.
 */
export async function deliverWebhookEvent(
  db: Db,
  args: { event: string; agentIds: string[]; payload: unknown; fetcher?: typeof fetch },
): Promise<{ delivered: number; failed: number }> {
  if (args.agentIds.length === 0) return { delivered: 0, failed: 0 };
  const hooks = await db
    .select()
    .from(webhooks)
    .where(inArray(webhooks.agentId, args.agentIds));
  const subscribed = hooks.filter((h) => (h.events as string[]).includes(args.event));

  const fetcher = args.fetcher ?? fetch;
  let delivered = 0;
  let failed = 0;
  await Promise.all(
    subscribed.map(async (hook) => {
      const body = JSON.stringify({
        event: args.event,
        agent_id: hook.agentId,
        payload: args.payload,
        sent_at: new Date().toISOString(),
      });
      const signature = signPayload(hook.secret, body);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const res = await fetcher(hook.url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'x-clearing-event': args.event,
              'x-clearing-signature': signature,
            },
            body,
          });
          clearTimeout(timer);
          if (res.ok) {
            delivered++;
            return;
          }
        } catch {
          // fall through to retry
        }
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      }
      failed++;
    }),
  );
  return { delivered, failed };
}

/** Emit an event: enqueue on Inngest when configured, else inline best-effort. */
export function emitWebhookEvent(
  db: Db,
  args: { event: WebhookEvent; agentIds: string[]; payload: unknown },
): void {
  if (isInngestConfigured()) {
    void inngest
      .send({ name: 'webhook/dispatch', data: args })
      .catch((e) => console.error('webhook enqueue failed:', e));
    return;
  }
  void deliverWebhookEvent(db, args).catch((e) =>
    console.error('webhook delivery failed:', e),
  );
}

export async function listWebhooks(db: Db, agentId: string) {
  const rows = await db.select().from(webhooks).where(eq(webhooks.agentId, agentId));
  return rows.map((r) => ({ id: r.id, url: r.url, events: r.events, created_at: r.createdAt }));
}
