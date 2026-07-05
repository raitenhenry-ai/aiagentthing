import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { orders, reputationEvents } from '@/db/schema';
import { getConversation, sendMessage } from '@/lib/messages';
import { getMockRail } from '@/lib/payments';
import { addPortfolioItem, listPortfolio, removePortfolioItem } from '@/lib/portfolio';
import { getProfile } from '@/lib/profiles';
import { transitionOrder } from '@/lib/state-machine';
import {
  createTestDb,
  makeAgent,
  makeEscrowedOrder,
  makeListing,
  type TestAgent,
} from './helpers';

let db: Db;
let seller: TestAgent;
let buyer: TestAgent;

beforeEach(async () => {
  db = await createTestDb();
  seller = await makeAgent(db, 'seller');
  buyer = await makeAgent(db, 'buyer');
});

describe('portfolio (work examples on profiles)', () => {
  it('adds link, uploaded-file, and inline-sample items and serves them on the profile', async () => {
    await addPortfolioItem(db, {
      agentId: seller.id,
      title: 'CSV pipeline case study',
      description: 'Migrated 2M rows.',
      url: 'https://example.com/case-study',
    });
    await addPortfolioItem(db, {
      agentId: seller.id,
      title: 'Sample output',
      sample: { csv: 'a,b\n1,2', row_count: 1 },
    });
    // An "uploaded file": a data: URI (this is how agents upload).
    const png = `data:image/png;base64,${Buffer.from('fakepng').toString('base64')}`;
    await addPortfolioItem(db, { agentId: seller.id, title: 'Screenshot', url: png });

    const items = await listPortfolio(db, seller.id);
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toBe('CSV pipeline case study');
    expect(items[2]!.is_image).toBe(true); // data:image/* detected

    const profile = await getProfile(db, seller.id);
    expect(profile.portfolio).toHaveLength(3);
  });

  it('links an item to a settled order as verified proof-of-work (own orders only)', async () => {
    const listingId = await makeListing(db, seller.id, { priceCredits: 100n });
    const orderId = await makeEscrowedOrder(db, buyer, listingId, {});
    // Not settled yet → rejected.
    await expect(
      addPortfolioItem(db, { agentId: seller.id, title: 'x', sample: {}, orderId }),
    ).rejects.toThrow(/settled/);

    // Settle it (deliver-free path: expire → refund would be weird for a
    // showcase, so drive it to released via the machine).
    await transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id });
    await transitionOrder(db, { orderId, to: 'verifying', actor: 'system' });
    await transitionOrder(db, { orderId, to: 'passed', actor: 'panel' });
    await transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' });

    const { itemId } = await addPortfolioItem(db, {
      agentId: seller.id,
      title: 'Real delivered job',
      sample: { proof: true },
      orderId,
    });
    const items = await listPortfolio(db, seller.id);
    expect(items.find((i) => i.id === itemId)?.verified).toBe(true);

    // A stranger cannot showcase someone else's order.
    const stranger = await makeAgent(db, 'stranger');
    await expect(
      addPortfolioItem(db, { agentId: stranger.id, title: 'not mine', sample: {}, orderId }),
    ).rejects.toThrow(/your own orders/);
  });

  it('validates inputs and supports removal', async () => {
    await expect(
      addPortfolioItem(db, { agentId: seller.id, title: 'no content' }),
    ).rejects.toThrow(/url .*or a sample/i);
    await expect(
      addPortfolioItem(db, { agentId: seller.id, title: 'bad url', url: 'ftp://nope' }),
    ).rejects.toThrow(/http\(s\)/);

    const { itemId } = await addPortfolioItem(db, {
      agentId: seller.id,
      title: 'temp',
      url: 'https://x.example',
    });
    await removePortfolioItem(db, { agentId: seller.id, itemId });
    expect(await listPortfolio(db, seller.id)).toHaveLength(0);
    // Removing someone else's item fails.
    await expect(
      removePortfolioItem(db, { agentId: buyer.id, itemId }),
    ).rejects.toThrow(/not found/);
  });
});

describe('multiple services per seller', () => {
  it('one agent can run several active listings at once', async () => {
    const a = await makeListing(db, seller.id, { priceCredits: 100n });
    const b = await makeListing(db, seller.id, { priceCredits: 250n });
    const c = await makeListing(db, seller.id, { priceCredits: 900n });
    expect(new Set([a, b, c]).size).toBe(3);
    const profile = await getProfile(db, seller.id);
    expect(profile.active_listing_count).toBe(3);
  });
});

describe('seller declines a job', () => {
  it('escrowed → settled_refund by the seller; buyer gets the money back', async () => {
    const listingId = await makeListing(db, seller.id, { priceCredits: 500n });
    const orderId = await makeEscrowedOrder(db, buyer, listingId, {});
    const buyerWalletBefore = getMockRail().balanceOf(buyer.wallet);

    const { order } = await transitionOrder(db, {
      orderId,
      to: 'settled_refund',
      actor: 'seller',
      agentId: seller.id,
    });
    expect(order.state).toBe('settled_refund');
    // Refund payout executed post-commit; the ledger entries are the source
    // of truth here — buyer wallet receives the refund via the payout queue.
    const { processPayoutsForOrder } = await import('@/lib/payments/payouts');
    await processPayoutsForOrder(db, orderId);
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(buyerWalletBefore + 500n);

    // Milder reputation mark: -1 with reason seller_declined.
    const evts = await db
      .select()
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, seller.id));
    const decline = evts.find((e) => e.reason === 'seller_declined');
    expect(decline).toBeDefined();
    expect(decline!.delta).toBe(-1);
  });

  it('only the listing seller can decline, and only from escrowed', async () => {
    const listingId = await makeListing(db, seller.id, { priceCredits: 100n });
    const orderId = await makeEscrowedOrder(db, buyer, listingId, {});
    await expect(
      transitionOrder(db, { orderId, to: 'settled_refund', actor: 'seller', agentId: buyer.id }),
    ).rejects.toThrow(/Only the listing seller/);

    // Once delivered, decline is no longer available.
    await transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id });
    await expect(
      transitionOrder(db, { orderId, to: 'settled_refund', actor: 'seller', agentId: seller.id }),
    ).rejects.toThrow(/No transition/);
  });
});

describe('purchase message + uploads', () => {
  it('messages support attachments (links and data: uploads) end to end', async () => {
    const file = `data:text/csv;base64,${Buffer.from('a,b\n1,2').toString('base64')}`;
    await sendMessage(db, {
      senderAgentId: buyer.id,
      recipientAgentId: seller.id,
      body: 'Here is the source file for the job.',
      attachments: [
        { name: 'input.csv', url: file },
        { name: 'spec', url: 'https://example.com/spec' },
      ],
    });
    const thread = await getConversation(db, seller.id, buyer.id);
    expect(thread[0]!.attachments).toHaveLength(2);
    expect(thread[0]!.attachments[0]!.name).toBe('input.csv');
    expect(thread[0]!.attachments[0]!.url).toBe(file);
  });

  it('rejects oversized or malformed attachments', async () => {
    await expect(
      sendMessage(db, {
        senderAgentId: buyer.id,
        recipientAgentId: seller.id,
        body: 'big',
        attachments: [{ name: 'huge', url: `data:x;base64,${'A'.repeat(700_001)}` }],
      }),
    ).rejects.toThrow(/500KB/);
    await expect(
      sendMessage(db, {
        senderAgentId: buyer.id,
        recipientAgentId: seller.id,
        body: 'bad',
        attachments: [{ name: 'x', url: 'javascript:alert(1)' }],
      }),
    ).rejects.toThrow(/http\(s\) or a data/);
  });

  it('an order note lands on the thread pinned to the order', async () => {
    const listingId = await makeListing(db, seller.id, { priceCredits: 100n });
    const orderId = await makeEscrowedOrder(db, buyer, listingId, {});
    await sendMessage(db, {
      senderAgentId: buyer.id,
      recipientAgentId: seller.id,
      body: 'Please prioritize columns a and b.',
      orderId,
      attachments: [{ name: 'columns.txt', url: 'data:text/plain;base64,YSxi' }],
    });
    const thread = await getConversation(db, seller.id, buyer.id);
    expect(thread[0]!.order_id).toBe(orderId);
    expect(thread[0]!.attachments[0]!.name).toBe('columns.txt');
    // Order still intact.
    const o = await db.select({ state: orders.state }).from(orders).where(eq(orders.id, orderId));
    expect(o[0]!.state).toBe('escrowed');
  });
});
