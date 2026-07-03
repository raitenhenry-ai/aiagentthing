import { getDb } from '@/db/client';
import { resolveAppeal } from '@/lib/appeals';
import { transitionOrder } from '@/lib/state-machine';
import { runVerification } from '@/lib/verification/run';
import { deliverWebhookEvent } from '@/lib/webhooks';
import { inngest } from './client';

// Every state-machine timer and background task, as Inngest functions.
// The logic lives in the service layer — these are thin, idempotent shells
// (a lost race against an already-transitioned order is a no-op, not a
// failure, because the state machine rejects the stale transition).

export const verifyDelivered = inngest.createFunction(
  { id: 'order-verify', retries: 3, triggers: [{ event: 'order/delivered' }] },
  async ({ event }) => {
    const db = await getDb();
    return runVerification(db, event.data.orderId as string);
  },
);

export const expireOnDeadline = inngest.createFunction(
  { id: 'order-expiry-timer', retries: 3, triggers: [{ event: 'order/escrowed' }] },
  async ({ event, step }) => {
    await step.sleepUntil('until-deadline', event.data.deadlineAt as string);
    const db = await getDb();
    try {
      await transitionOrder(db, { orderId: event.data.orderId as string, to: 'expired', actor: 'system' });
      await transitionOrder(db, { orderId: event.data.orderId as string, to: 'settled_refund', actor: 'system' });
      return { expired: true };
    } catch {
      return { expired: false }; // already delivered/settled — timer is moot
    }
  },
);

export const lapseFailWindow = inngest.createFunction(
  { id: 'order-fail-window-timer', retries: 3, triggers: [{ event: 'order/failed' }] },
  async ({ event, step }) => {
    await step.sleepUntil('until-window-end', event.data.failWindowEndsAt as string);
    const db = await getDb();
    try {
      await transitionOrder(db, { orderId: event.data.orderId as string, to: 'settled_refund', actor: 'system' });
      return { refunded: true };
    } catch {
      return { refunded: false }; // overridden or appealed in the window
    }
  },
);

export const resolveAppealJob = inngest.createFunction(
  { id: 'order-appeal-resolution', retries: 3, triggers: [{ event: 'order/appealed' }] },
  async ({ event }) => {
    const db = await getDb();
    return resolveAppeal(db, event.data.orderId as string);
  },
);

export const deliverWebhook = inngest.createFunction(
  { id: 'webhook-delivery', retries: 5, triggers: [{ event: 'webhook/dispatch' }] },
  async ({ event }) => {
    const db = await getDb();
    return deliverWebhookEvent(db, {
      event: event.data.event as string,
      agentIds: event.data.agentIds as string[],
      payload: event.data.payload,
    });
  },
);

export const allFunctions = [
  verifyDelivered,
  expireOnDeadline,
  lapseFailWindow,
  resolveAppealJob,
  deliverWebhook,
];
