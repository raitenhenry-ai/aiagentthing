import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import {
  getConversation,
  listConversations,
  pairKey,
  sendMessage,
  unreadCount,
} from '@/lib/messages';
import { createTestDb, makeAgent, makeListing, makeEscrowedOrder, type TestAgent } from './helpers';

let db: Db;
let alice: TestAgent;
let bob: TestAgent;

beforeEach(async () => {
  db = await createTestDb();
  alice = await makeAgent(db, 'alice');
  bob = await makeAgent(db, 'bob');
});

describe('messaging', () => {
  it('sends a message and reads it back as one ordered thread', async () => {
    await sendMessage(db, { senderAgentId: alice.id, recipientAgentId: bob.id, body: 'hi bob, are you free?' });
    await sendMessage(db, { senderAgentId: bob.id, recipientAgentId: alice.id, body: 'yes — what do you need?' });
    await sendMessage(db, { senderAgentId: alice.id, recipientAgentId: bob.id, body: 'a CSV job' });

    const thread = await getConversation(db, alice.id, bob.id);
    expect(thread.map((m) => m.body)).toEqual([
      'hi bob, are you free?',
      'yes — what do you need?',
      'a CSV job',
    ]);
    // From alice's view, her own messages are "mine".
    expect(thread[0]!.mine).toBe(true);
    expect(thread[1]!.mine).toBe(false);
  });

  it('pairKey is symmetric so both sides share one thread', async () => {
    expect(pairKey(alice.id, bob.id)).toBe(pairKey(bob.id, alice.id));
    await sendMessage(db, { senderAgentId: bob.id, recipientAgentId: alice.id, body: 'ping' });
    const fromAlice = await getConversation(db, alice.id, bob.id);
    const fromBob = await getConversation(db, bob.id, alice.id);
    expect(fromAlice).toHaveLength(1);
    expect(fromBob).toHaveLength(1);
  });

  it('tracks unread and marks read when the recipient opens the thread', async () => {
    await sendMessage(db, { senderAgentId: alice.id, recipientAgentId: bob.id, body: 'm1' });
    await sendMessage(db, { senderAgentId: alice.id, recipientAgentId: bob.id, body: 'm2' });
    expect(await unreadCount(db, bob.id)).toBe(2);
    expect(await unreadCount(db, alice.id)).toBe(0);

    // Bob opens the conversation → his inbound messages are marked read.
    await getConversation(db, bob.id, alice.id);
    expect(await unreadCount(db, bob.id)).toBe(0);
  });

  it('inbox lists conversations newest-first with unread counts and counterparty name', async () => {
    const carol = await makeAgent(db, 'carol');
    await sendMessage(db, { senderAgentId: bob.id, recipientAgentId: alice.id, body: 'from bob' });
    await sendMessage(db, { senderAgentId: carol.id, recipientAgentId: alice.id, body: 'from carol' });

    const inbox = await listConversations(db, alice.id);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]!.with_agent_id).toBe(carol.id); // most recent first
    expect(inbox[0]!.with_name).toBe('carol');
    expect(inbox[0]!.unread).toBe(1);
    expect(inbox[0]!.last_from_me).toBe(false);
  });

  it('rejects self-messages, empty bodies, and unknown recipients', async () => {
    await expect(
      sendMessage(db, { senderAgentId: alice.id, recipientAgentId: alice.id, body: 'me' }),
    ).rejects.toThrow(/itself/);
    await expect(
      sendMessage(db, { senderAgentId: alice.id, recipientAgentId: bob.id, body: '   ' }),
    ).rejects.toThrow(/required/);
    await expect(
      sendMessage(db, { senderAgentId: alice.id, recipientAgentId: 'agt_nope', body: 'hi' }),
    ).rejects.toThrow(/not found/);
  });

  it('an order-pinned message requires the sender to be a party to the order', async () => {
    const listingId = await makeListing(db, bob.id, { priceCredits: 100n });
    const orderId = await makeEscrowedOrder(db, alice, listingId, {});
    // alice (buyer) and bob (seller) are parties → allowed.
    await expect(
      sendMessage(db, { senderAgentId: alice.id, recipientAgentId: bob.id, body: 'about the order', orderId }),
    ).resolves.toBeTruthy();
    // A stranger cannot pin to that order.
    const mallory = await makeAgent(db, 'mallory');
    await expect(
      sendMessage(db, { senderAgentId: mallory.id, recipientAgentId: bob.id, body: 'nosy', orderId }),
    ).rejects.toThrow(/not a party/);
  });
});
