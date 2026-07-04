import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { orders } from '@/db/schema';
import { getBalance, agentAccount, ledgerSum } from '@/lib/ledger';
import { createInvoice, listInvoices, payInvoice, voidInvoice } from '@/lib/invoices';
import { createOrderQuote, payForOrder, submitDelivery } from '@/lib/orders';
import { getMockRail } from '@/lib/payments';
import { requestWithdrawal, tipOrder } from '@/lib/payments/extras';
import { MockRail } from '@/lib/payments/mock-rail';
import { getProfile, updateProfile } from '@/lib/profiles';
import { acceptQuote, declineQuote, requestQuote, respondToQuote } from '@/lib/quotes';
import { listReviews, reviewSummary, submitReview } from '@/lib/reviews';
import { createListing } from '@/lib/listings';
import {
  createTestDb,
  fund,
  fundWallet,
  makeAgent,
  makeEscrowedOrder,
  makeListing,
  TEST_CRITERIA,
  type TestAgent,
} from './helpers';

let db: Db;
let buyer: TestAgent;
let seller: TestAgent;
let listingId: string;

beforeEach(async () => {
  db = await createTestDb();
  buyer = await makeAgent(db, 'buyer');
  seller = await makeAgent(db, 'seller');
  listingId = await makeListing(db, seller.id, { priceCredits: 1000n });
});

async function settledOrder(): Promise<string> {
  const orderId = await makeEscrowedOrder(db, buyer, listingId);
  await submitDelivery(db, {
    orderId,
    sellerAgentId: seller.id,
    artifacts: [{ inline: { summary: 'done' } }],
    receipts: [],
  });
  return orderId;
}

describe('profiles', () => {
  it('agents update their own profile; trust fields stay server-computed', async () => {
    await updateProfile(db, seller.id, {
      name: 'SummarizerPro',
      bio: 'I summarize documents with citations.',
      website: 'https://summarizer.example',
      tags: ['Summarization', 'NLP'],
    });
    const profile = await getProfile(db, seller.id);
    expect(profile).toMatchObject({
      name: 'SummarizerPro',
      tags: ['summarization', 'nlp'], // normalized lowercase
      reputation: { score: 50 },
      reviews: { review_count: 0, average_rating: null },
    });
    expect(profile.wallet_address).toBe(seller.wallet);
  });

  it('profile aggregates settled stats and review summary', async () => {
    const orderId = await settledOrder();
    await submitReview(db, { orderId, reviewerAgentId: buyer.id, rating: 5, comment: 'great' });
    const profile = await getProfile(db, seller.id);
    expect(profile.reputation.seller_settled_count).toBe(1);
    expect(profile.reviews).toMatchObject({ review_count: 1, average_rating: 5 });
  });
});

describe('reviews', () => {
  it('both parties can review a settled order, once, and only each other', async () => {
    const orderId = await settledOrder();
    const r1 = await submitReview(db, { orderId, reviewerAgentId: buyer.id, rating: 4 });
    expect(r1.subjectAgentId).toBe(seller.id);
    const r2 = await submitReview(db, { orderId, reviewerAgentId: seller.id, rating: 5 });
    expect(r2.subjectAgentId).toBe(buyer.id);

    await expect(
      submitReview(db, { orderId, reviewerAgentId: buyer.id, rating: 1 }),
    ).rejects.toThrow(/already reviewed/);

    const stranger = await makeAgent(db, 'stranger');
    await expect(
      submitReview(db, { orderId, reviewerAgentId: stranger.id, rating: 5 }),
    ).rejects.toThrow(/not found/i);
  });

  it('unsettled orders cannot be reviewed', async () => {
    const orderId = await makeEscrowedOrder(db, buyer, listingId);
    await expect(
      submitReview(db, { orderId, reviewerAgentId: buyer.id, rating: 3 }),
    ).rejects.toThrow(/settled/);
  });

  it('summary aggregates ratings and histogram', async () => {
    for (const rating of [5, 4]) {
      const orderId = await settledOrder();
      await submitReview(db, { orderId, reviewerAgentId: buyer.id, rating });
    }
    const summary = await reviewSummary(db, seller.id);
    expect(summary).toMatchObject({ review_count: 2, average_rating: 4.5 });
    expect(summary.rating_histogram['5']).toBe(1);
    const list = await listReviews(db, seller.id);
    expect(list).toHaveLength(2);
  });
});

describe('quotes (RFQ)', () => {
  let quoteListing: string;
  beforeEach(async () => {
    quoteListing = await createListing(db, {
      sellerAgentId: seller.id,
      title: 'Custom research',
      pricingMode: 'quote',
      priceCredits: 0n,
      turnaroundSeconds: 3600,
      acceptanceCriteria: TEST_CRITERIA,
      status: 'active',
    });
  });

  it('quote-priced listings reject direct orders', async () => {
    await expect(
      createOrderQuote(db, { buyerAgentId: buyer.id, listingId: quoteListing, inputPayload: {} }),
    ).rejects.toThrow(/quote/i);
  });

  it('full RFQ flow: request → respond → accept → pay → deliver → settle at quoted terms', async () => {
    const { quoteId } = await requestQuote(db, {
      buyerAgentId: buyer.id,
      listingId: quoteListing,
      inputPayload: { doc: 'niche topic' },
      message: 'How much for this?',
    });
    await respondToQuote(db, {
      quoteId,
      sellerAgentId: seller.id,
      priceCredits: 2500n,
      turnaroundSeconds: 7200,
      message: 'Custom rate for the niche topic',
    });
    const { orderId, priceCredits } = await acceptQuote(db, { quoteId, buyerAgentId: buyer.id });
    expect(priceCredits).toBe(2500n);

    fundWallet(buyer.wallet, 2500n);
    await payForOrder(db, {
      orderId,
      buyerAgentId: buyer.id,
      buyerWallet: buyer.wallet,
      paymentHeader: MockRail.paymentHeader(buyer.wallet),
    });
    const { verdict } = await submitDelivery(db, {
      orderId,
      sellerAgentId: seller.id,
      artifacts: [{ inline: { summary: 'niche summary' } }],
      receipts: [],
    });
    expect(verdict).toBe('PASS');
    // 2500 - 10% fee = 2250 on the seller wallet.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(2250n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('guards: only the seller responds, only the buyer accepts, no double-accept', async () => {
    const { quoteId } = await requestQuote(db, {
      buyerAgentId: buyer.id,
      listingId: quoteListing,
      inputPayload: {},
    });
    await expect(
      respondToQuote(db, { quoteId, sellerAgentId: buyer.id, priceCredits: 1n, turnaroundSeconds: 60 }),
    ).rejects.toThrow(/not found/i);
    await expect(acceptQuote(db, { quoteId, buyerAgentId: buyer.id })).rejects.toThrow(/pending/);
    await respondToQuote(db, { quoteId, sellerAgentId: seller.id, priceCredits: 100n, turnaroundSeconds: 60 });
    await expect(acceptQuote(db, { quoteId, buyerAgentId: seller.id })).rejects.toThrow(/not found/i);
    await acceptQuote(db, { quoteId, buyerAgentId: buyer.id });
    await expect(acceptQuote(db, { quoteId, buyerAgentId: buyer.id })).rejects.toThrow(/accepted/);
  });

  it('declined quotes cannot be accepted', async () => {
    const { quoteId } = await requestQuote(db, {
      buyerAgentId: buyer.id,
      listingId: quoteListing,
      inputPayload: {},
    });
    await declineQuote(db, { quoteId, agentId: seller.id });
    await expect(acceptQuote(db, { quoteId, buyerAgentId: buyer.id })).rejects.toThrow(/declined/);
  });
});

describe('invoices', () => {
  it('create → pay via x402 → seller wallet paid in full, zero fee, ledger zero', async () => {
    const { invoiceId, amountCredits } = await createInvoice(db, {
      sellerAgentId: seller.id,
      buyerAgentId: buyer.id,
      lineItems: [
        { description: 'consulting', amount_credits: 3000 },
        { description: 'rush fee', amount_credits: 500 },
      ],
      memo: 'March services',
    });
    expect(amountCredits).toBe(3500n);

    fundWallet(buyer.wallet, 3500n);
    const paid = await payInvoice(db, {
      invoiceId,
      buyerAgentId: buyer.id,
      buyerWallet: buyer.wallet,
      paymentHeader: MockRail.paymentHeader(buyer.wallet),
    });
    // Invoices are true wallet-to-wallet: 100% lands on the seller's wallet.
    expect(paid.fee).toBe(0n);
    expect(paid.netToSeller).toBe(3500n);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(3500n);
    expect(await ledgerSum(db)).toBe(0n);

    const list = await listInvoices(db, seller.id);
    expect(list[0]).toMatchObject({ status: 'paid', role: 'seller' });

    // No double pay.
    fundWallet(buyer.wallet, 3500n);
    await expect(
      payInvoice(db, {
        invoiceId,
        buyerAgentId: buyer.id,
        buyerWallet: buyer.wallet,
        paymentHeader: MockRail.paymentHeader(buyer.wallet),
      }),
    ).rejects.toThrow(/already paid/i);
  });

  it('only the billed agent can pay; voided invoices cannot be paid; no self-billing', async () => {
    const { invoiceId } = await createInvoice(db, {
      sellerAgentId: seller.id,
      buyerAgentId: buyer.id,
      lineItems: [{ description: 'x', amount_credits: 100 }],
    });
    const mallory = await makeAgent(db, 'mallory');
    fundWallet(mallory.wallet, 100n);
    await expect(
      payInvoice(db, {
        invoiceId,
        buyerAgentId: mallory.id,
        buyerWallet: mallory.wallet,
        paymentHeader: MockRail.paymentHeader(mallory.wallet),
      }),
    ).rejects.toThrow(/not found/i);
    await voidInvoice(db, { invoiceId, sellerAgentId: seller.id });
    fundWallet(buyer.wallet, 100n);
    await expect(
      payInvoice(db, {
        invoiceId,
        buyerAgentId: buyer.id,
        buyerWallet: buyer.wallet,
        paymentHeader: MockRail.paymentHeader(buyer.wallet),
      }),
    ).rejects.toThrow(/void/);
    await expect(
      createInvoice(db, {
        sellerAgentId: seller.id,
        buyerAgentId: seller.id,
        lineItems: [{ description: 'x', amount_credits: 1 }],
      }),
    ).rejects.toThrow(/itself/);
  });
});

describe('tips & withdrawals', () => {
  it('buyer tips a settled order; seller wallet receives the full tip (0 fee default)', async () => {
    const orderId = await settledOrder();
    const before = getMockRail().balanceOf(seller.wallet);
    fundWallet(buyer.wallet, 250n);
    const { net } = await tipOrder(db, {
      orderId,
      buyerAgentId: buyer.id,
      buyerWallet: buyer.wallet,
      amountCredits: 250n,
      paymentHeader: MockRail.paymentHeader(buyer.wallet),
    });
    expect(net).toBe(250n);
    expect(getMockRail().balanceOf(seller.wallet) - before).toBe(250n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('unsettled orders cannot be tipped', async () => {
    const orderId = await makeEscrowedOrder(db, buyer, listingId);
    fundWallet(buyer.wallet, 100n);
    await expect(
      tipOrder(db, {
        orderId,
        buyerAgentId: buyer.id,
        buyerWallet: buyer.wallet,
        amountCredits: 100n,
        paymentHeader: MockRail.paymentHeader(buyer.wallet),
      }),
    ).rejects.toThrow(/settled/);
  });

  it('withdrawals drain leftover credits to the wallet, respecting the minimum', async () => {
    await fund(db, buyer.id, 500n); // stranded credits (e.g. surplus payment)
    getMockRail().fund('0xp1a7f0rm000000000000000000000000000000000', 500n); // chain backing
    await expect(
      requestWithdrawal(db, { agentId: buyer.id, walletAddress: buyer.wallet, amountCredits: 5n }),
    ).rejects.toThrow(/minimum/i);
    const result = await requestWithdrawal(db, {
      agentId: buyer.id,
      walletAddress: buyer.wallet,
      amountCredits: 500n,
    });
    expect(result.status).toBe('confirmed');
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(500n);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(0n);
    expect(await ledgerSum(db)).toBe(0n);

    // Can't withdraw what you don't have.
    await expect(
      requestWithdrawal(db, { agentId: buyer.id, walletAddress: buyer.wallet, amountCredits: 500n }),
    ).rejects.toThrow(/Insufficient/);
  });
});

describe('order quote TTL', () => {
  it('stale created orders cannot be paid', async () => {
    const quote = await createOrderQuote(db, {
      buyerAgentId: buyer.id,
      listingId,
      inputPayload: {},
    });
    // Age the order past the TTL.
    await db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - 100 * 24 * 3600 * 1000) })
      .where(eq(orders.id, quote.orderId));
    fundWallet(buyer.wallet, 1000n);
    await expect(
      payForOrder(db, {
        orderId: quote.orderId,
        buyerAgentId: buyer.id,
        buyerWallet: buyer.wallet,
        paymentHeader: MockRail.paymentHeader(buyer.wallet),
      }),
    ).rejects.toThrow(/expired/);
  });
});
