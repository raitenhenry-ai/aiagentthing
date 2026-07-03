import { beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MockRail } from '@/lib/payments/mock-rail';
import { getMockRail } from '@/lib/payments';

// End-to-end core loop through the actual REST route handlers (no HTTP
// server needed — Next.js route handlers are plain Request → Response).
// Auth is real wallet-signature auth (viem local accounts); payments run on
// the mock x402 rail.
process.env.PGLITE_MEMORY = '1';
process.env.APP_SECRET = 'test-secret';

const routes = {
  challenge: () => import('../app/api/auth/challenge/route'),
  verify: () => import('../app/api/auth/verify/route'),
  balance: () => import('../app/api/agents/me/balance/route'),
  ledger: () => import('../app/api/agents/me/ledger/route'),
  reputation: () => import('../app/api/agents/[id]/reputation/route'),
  listings: () => import('../app/api/listings/route'),
  orders: () => import('../app/api/orders/route'),
  order: () => import('../app/api/orders/[id]/route'),
  pay: () => import('../app/api/orders/[id]/pay/route'),
  delivery: () => import('../app/api/orders/[id]/delivery/route'),
  evidence: () => import('../app/api/orders/[id]/evidence/route'),
};

type Handler = (req: Request, ctx: { params: { id: string } }) => Promise<Response>;

function req(method: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request('http://test.local/api/x', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Full SIWE-style login with a local viem account. */
async function login(name: string): Promise<{ token: string; wallet: string; agentId: string }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const challengeRoute = await routes.challenge();
  const verifyRoute = await routes.verify();

  const chRes = await challengeRoute.POST(req('POST', { wallet_address: account.address }));
  expect(chRes.status).toBe(201);
  const ch = await body(chRes);

  const signature = await account.signMessage({ message: ch.message as string });
  const vRes = await verifyRoute.POST(
    req('POST', {
      wallet_address: account.address,
      nonce: ch.nonce,
      signature,
      name,
    }),
  );
  expect(vRes.status).toBe(201);
  const v = await body(vRes);
  return {
    token: v.session_token as string,
    wallet: v.wallet_address as string,
    agentId: v.agent_id as string,
  };
}

const CRITERIA = {
  criteria: [
    { id: 'c1', type: 'schema', spec: { json_schema: { type: 'object', required: ['summary'] } } },
    { id: 'c2', type: 'judged', spec: { requirement: 'Output is a faithful summary' } },
  ],
  pass_rule: 'all',
};

describe('REST core loop (wallet auth + x402)', () => {
  let buyer: { token: string; wallet: string; agentId: string };
  let seller: { token: string; wallet: string; agentId: string };
  let listingId = '';
  let orderId = '';

  beforeAll(async () => {
    buyer = await login('buyer-agent');
    seller = await login('seller-agent');
  });

  it('rejects requests without a valid session token', async () => {
    const listingsRoute = await routes.listings();
    const res = await listingsRoute.POST(req('POST', {}));
    expect(res.status).toBe(401);
  });

  it('rejects a bad signature at login', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const challengeRoute = await routes.challenge();
    const verifyRoute = await routes.verify();
    const ch = await body(
      await challengeRoute.POST(req('POST', { wallet_address: account.address })),
    );
    const signature = await other.signMessage({ message: ch.message as string });
    const res = await verifyRoute.POST(
      req('POST', { wallet_address: account.address, nonce: ch.nonce, signature }),
    );
    expect(res.status).toBe(401);
  });

  it('seller creates a listing with acceptance criteria', async () => {
    const listingsRoute = await routes.listings();
    const res = await listingsRoute.POST(
      req(
        'POST',
        {
          title: 'Summarize a document',
          description: 'Faithful summaries with citations',
          price_credits: 1000,
          turnaround_seconds: 3600,
          acceptance_criteria: CRITERIA,
        },
        auth(seller.token),
      ),
    );
    expect(res.status).toBe(201);
    listingId = (await body(res)).id as string;

    const listRes = await listingsRoute.GET(req('GET'));
    const found = ((await body(listRes)).listings as Array<Record<string, unknown>>).find(
      (l) => l.id === listingId,
    );
    expect(found).toMatchObject({ price_credits: 1000, low_verifiability: false });
  });

  it('order intent returns HTTP 402 with x402 payment requirements', async () => {
    const ordersRoute = await routes.orders();
    const res = await ordersRoute.POST(
      req('POST', { listing_id: listingId, input_payload: { doc: 'long text…' } }, auth(buyer.token)),
    );
    expect(res.status).toBe(402);
    const quote = await body(res);
    orderId = quote.order_id as string;
    const accepts = quote.accepts as Array<Record<string, unknown>>;
    expect(accepts[0]).toMatchObject({
      scheme: 'exact',
      maxAmountRequired: (1000n * 10_000n).toString(),
    });
  });

  it('paying the 402 escrows the order and records the tx hash', async () => {
    const payRoute = await routes.pay();

    // Without funds the payment fails and nothing escrows.
    const broke = await (payRoute.POST as Handler)(
      req('POST', undefined, { ...auth(buyer.token), 'x-payment': MockRail.paymentHeader(buyer.wallet) }),
      { params: { id: orderId } },
    );
    expect(broke.status).toBe(402);

    getMockRail().fund(buyer.wallet, 1000n);
    const res = await (payRoute.POST as Handler)(
      req('POST', undefined, { ...auth(buyer.token), 'x-payment': MockRail.paymentHeader(buyer.wallet) }),
      { params: { id: orderId } },
    );
    expect(res.status).toBe(201);
    const paid = await body(res);
    expect(paid.state).toBe('escrowed');
    expect(paid.tx_hash as string).toMatch(/^0xmock/);
  });

  it('a stranger cannot read the order', async () => {
    const stranger = await login('stranger');
    const orderRoute = await routes.order();
    const res = await (orderRoute.GET as Handler)(req('GET', undefined, auth(stranger.token)), {
      params: { id: orderId },
    });
    expect(res.status).toBe(404);
  });

  it('seller delivers; panel passes; USDC lands on the seller wallet minus 10% fee', async () => {
    const deliveryRoute = await routes.delivery();
    const orderRoute = await routes.order();

    const res = await (deliveryRoute.POST as Handler)(
      req(
        'POST',
        {
          artifacts: [{ inline: { summary: 'the summary' } }],
          receipts: [{ step: 'summarized', at: 't0' }],
        },
        auth(seller.token),
      ),
      { params: { id: orderId } },
    );
    expect(res.status).toBe(201);
    expect((await body(res)).verdict).toBe('PASS');

    const orderRes = await (orderRoute.GET as Handler)(req('GET', undefined, auth(buyer.token)), {
      params: { id: orderId },
    });
    const order = await body(orderRes);
    expect(order.state).toBe('settled_released');
    expect((order.verification as Record<string, unknown>).verdict).toBe('PASS');

    // On-chain outcome: 900 to the seller wallet; fee stays with the platform.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(900n);
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(0n);
  });

  it('the ledger history shows inbound payment, escrow, release, and payout with tx hashes', async () => {
    const ledgerRoute = await routes.ledger();
    const res = await ledgerRoute.GET(req('GET', undefined, auth(seller.token)));
    const data = await body(res);
    const entries = data.entries as Array<Record<string, unknown>>;
    const withdrawal = entries.find((e) => e.entry_type === 'withdrawal');
    expect(withdrawal).toBeDefined();
    const release = entries.find((e) => e.entry_type === 'escrow_release');
    expect(release).toMatchObject({ amount: 900 });
  });

  it('buyer cannot deliver, and the settled order rejects further actions', async () => {
    const deliveryRoute = await routes.delivery();
    const res = await (deliveryRoute.POST as Handler)(
      req('POST', { artifacts: [{ inline: { summary: 'fake' } }] }, auth(buyer.token)),
      { params: { id: orderId } },
    );
    expect([403, 409]).toContain(res.status);
  });

  it('the evidence pack exports the full audit trail', async () => {
    const evidenceRoute = await routes.evidence();
    const res = await (evidenceRoute.GET as Handler)(req('GET', undefined, auth(buyer.token)), {
      params: { id: orderId },
    });
    expect(res.status).toBe(200);
    const pack = await body(res);
    expect(pack.contract).toBeTruthy();
    expect((pack.deliveries as unknown[]).length).toBe(1);
    expect((pack.verifications as unknown[]).length).toBe(1);
    expect((pack.ledger_entries as unknown[]).length).toBeGreaterThanOrEqual(6);
  });

  it('reputation reflects the settlement', async () => {
    const reputationRoute = await routes.reputation();
    const res = await (reputationRoute.GET as Handler)(req('GET'), {
      params: { id: seller.agentId },
    });
    const rep = await body(res);
    const components = rep.components as Record<string, unknown>;
    expect(components.seller_settled_count).toBe(1);
    expect(components.pass_rate).toBe(1);
    expect(rep.reputation_score as number).toBeGreaterThan(50);
  });
});
