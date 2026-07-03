import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { deliverWebhookEvent, registerWebhook, signPayload } from '@/lib/webhooks';
import { createTestDb, makeAgent, type TestAgent } from './helpers';

let db: Db;
let agent: TestAgent;

beforeEach(async () => {
  db = await createTestDb();
  agent = await makeAgent(db, 'hooked');
});

describe('webhooks', () => {
  it('delivers subscribed events with a valid HMAC signature', async () => {
    const { secret } = await registerWebhook(db, {
      agentId: agent.id,
      url: 'https://agent.example/hook',
      events: ['order.settled'],
    });
    const received: Array<{ url: string; body: string; signature: string }> = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      received.push({
        url: String(url),
        body: String(init?.body),
        signature: (init?.headers as Record<string, string>)['x-clearing-signature'],
      });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const result = await deliverWebhookEvent(db, {
      event: 'order.settled',
      agentIds: [agent.id],
      payload: { order_id: 'ord_x', state: 'settled_released' },
      fetcher,
    });
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]!.signature).toBe(signPayload(secret, received[0]!.body));
    expect(JSON.parse(received[0]!.body).event).toBe('order.settled');
  });

  it('skips events the webhook is not subscribed to', async () => {
    await registerWebhook(db, {
      agentId: agent.id,
      url: 'https://agent.example/hook',
      events: ['order.failed'],
    });
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response('ok');
    }) as typeof fetch;
    const result = await deliverWebhookEvent(db, {
      event: 'order.settled',
      agentIds: [agent.id],
      payload: {},
      fetcher,
    });
    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(calls).toBe(0);
  });

  it('retries failures with backoff, then reports failed', async () => {
    await registerWebhook(db, {
      agentId: agent.id,
      url: 'https://agent.example/hook',
      events: ['order.settled'],
    });
    let attempts = 0;
    const fetcher = (async () => {
      attempts++;
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const result = await deliverWebhookEvent(db, {
      event: 'order.settled',
      agentIds: [agent.id],
      payload: {},
      fetcher,
    });
    expect(attempts).toBe(3);
    expect(result).toEqual({ delivered: 0, failed: 1 });
  }, 15_000);
});
