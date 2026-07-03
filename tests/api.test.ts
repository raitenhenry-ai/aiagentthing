import { beforeAll, describe, expect, it } from 'vitest';

// End-to-end core loop through the actual REST route handlers (no HTTP
// server needed — Next.js route handlers are plain Request → Response).
process.env.PGLITE_MEMORY = '1';
process.env.APP_SECRET = 'test-secret';

type RouteModule = Record<string, (req: Request, ctx?: never) => Promise<Response>>;

const routes = {
  accounts: () => import('../app/api/accounts/route'),
  agents: () => import('../app/api/agents/route'),
  balance: () => import('../app/api/agents/me/balance/route'),
  reputation: () => import('../app/api/agents/[id]/reputation/route'),
  topup: () => import('../app/api/dev/topup/route'),
  listings: () => import('../app/api/listings/route'),
  listing: () => import('../app/api/listings/[id]/route'),
  orders: () => import('../app/api/orders/route'),
  order: () => import('../app/api/orders/[id]/route'),
  delivery: () => import('../app/api/orders/[id]/delivery/route'),
};

function req(
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request('http://test.local/api/x', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const CRITERIA = {
  criteria: [
    { id: 'c1', type: 'schema', spec: { json_schema: { type: 'object' } } },
    { id: 'c2', type: 'judged', spec: { requirement: 'Output is a faithful summary' } },
  ],
  pass_rule: 'all',
};

describe('REST core loop', () => {
  let buyerKey = '';
  let sellerKey = '';
  let buyerId = '';
  let sellerId = '';
  let listingId = '';
  let orderId = '';

  beforeAll(async () => {
    const accountsRoute = await routes.accounts();
    const agentsRoute = await routes.agents();
    const topupRoute = await routes.topup();

    const acctRes = await accountsRoute.POST(req('POST', { email: 'owner@example.com' }));
    expect(acctRes.status).toBe(201);
    const acct = await body(acctRes);

    for (const [name, setKey, setId] of [
      ['buyer-agent', (k: string) => (buyerKey = k), (i: string) => (buyerId = i)],
      ['seller-agent', (k: string) => (sellerKey = k), (i: string) => (sellerId = i)],
    ] as const) {
      const res = await agentsRoute.POST(
        req('POST', { account_id: acct.id, name, capabilities: ['buyer', 'seller'] }),
      );
      expect(res.status).toBe(201);
      const agent = await body(res);
      setKey(agent.api_key as string);
      setId(agent.id as string);
    }

    const topupRes = await topupRoute.POST(
      req('POST', { agent_id: buyerId, amount_credits: 10_000 }, { 'x-app-secret': 'test-secret' }),
    );
    expect(topupRes.status).toBe(201);
  });

  it('rejects requests without a valid API key', async () => {
    const listingsRoute = await routes.listings();
    const res = await listingsRoute.POST(req('POST', {}));
    expect(res.status).toBe(401);
  });

  it('rejects dev topup without the app secret', async () => {
    const topupRoute = await routes.topup();
    const res = await topupRoute.POST(req('POST', { agent_id: buyerId, amount_credits: 1 }));
    expect(res.status).toBe(403);
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
        auth(sellerKey),
      ),
    );
    expect(res.status).toBe(201);
    listingId = (await body(res)).id as string;

    const listRes = await listingsRoute.GET(req('GET'));
    const listBody = await body(listRes);
    const found = (listBody.listings as Array<Record<string, unknown>>).find(
      (l) => l.id === listingId,
    );
    expect(found).toMatchObject({ price_credits: 1000, low_verifiability: false });
  });

  it('buyer purchases: order is escrowed and credits are held', async () => {
    const ordersRoute = await routes.orders();
    const balanceRoute = await routes.balance();

    const res = await ordersRoute.POST(
      req('POST', { listing_id: listingId, input_payload: { doc: 'long text…' } }, auth(buyerKey)),
    );
    expect(res.status).toBe(201);
    const order = await body(res);
    orderId = order.id as string;
    expect(order.state).toBe('escrowed');

    const balRes = await balanceRoute.GET(req('GET', undefined, auth(buyerKey)));
    expect((await body(balRes)).balance_credits).toBe(9000);
  });

  it('rejects a purchase the buyer cannot afford', async () => {
    const listingsRoute = await routes.listings();
    const ordersRoute = await routes.orders();
    const bigRes = await listingsRoute.POST(
      req(
        'POST',
        {
          title: 'Expensive service',
          price_credits: 1_000_000,
          turnaround_seconds: 60,
          acceptance_criteria: CRITERIA,
        },
        auth(sellerKey),
      ),
    );
    const bigListing = (await body(bigRes)).id as string;
    const res = await ordersRoute.POST(
      req('POST', { listing_id: bigListing, input_payload: {} }, auth(buyerKey)),
    );
    expect(res.status).toBe(402);
  });

  it('a stranger cannot read the order', async () => {
    const agentsRoute = await routes.agents();
    const accountsRoute = await routes.accounts();
    const orderRoute = await routes.order();
    const acct = await body(await accountsRoute.POST(req('POST', { email: 'x@example.com' })));
    const stranger = await body(
      await agentsRoute.POST(req('POST', { account_id: acct.id, name: 'stranger', capabilities: ['buyer'] })),
    );
    const res = await (orderRoute.GET as unknown as (r: Request, c: { params: { id: string } }) => Promise<Response>)(
      req('GET', undefined, auth(stranger.api_key as string)),
      { params: { id: orderId } },
    );
    expect(res.status).toBe(404);
  });

  it('seller delivers; stub panel passes; order settles and seller is paid net of 10% fee', async () => {
    const deliveryRoute = await routes.delivery();
    const orderRoute = await routes.order();
    const balanceRoute = await routes.balance();

    const res = await (deliveryRoute.POST as unknown as (r: Request, c: { params: { id: string } }) => Promise<Response>)(
      req(
        'POST',
        { artifacts: [{ inline: { summary: 'the summary' } }], receipts: [{ step: 'summarized', at: 't0' }] },
        auth(sellerKey),
      ),
      { params: { id: orderId } },
    );
    expect(res.status).toBe(201);
    expect((await body(res)).verdict).toBe('PASS');

    const orderRes = await (orderRoute.GET as unknown as (r: Request, c: { params: { id: string } }) => Promise<Response>)(
      req('GET', undefined, auth(buyerKey)),
      { params: { id: orderId } },
    );
    const order = await body(orderRes);
    expect(order.state).toBe('settled_released');
    expect(order.settled_at).toBeTruthy();
    const verification = order.verification as Record<string, unknown>;
    expect(verification.verdict).toBe('PASS');

    const sellerBal = await body(await balanceRoute.GET(req('GET', undefined, auth(sellerKey))));
    expect(sellerBal.balance_credits).toBe(900);
  });

  it('buyer cannot deliver, and the settled order rejects further actions', async () => {
    const deliveryRoute = await routes.delivery();
    const res = await (deliveryRoute.POST as unknown as (r: Request, c: { params: { id: string } }) => Promise<Response>)(
      req('POST', { artifacts: [{ inline: { summary: 'fake' } }] }, auth(buyerKey)),
      { params: { id: orderId } },
    );
    expect([403, 409]).toContain(res.status);
  });

  it('reputation reflects the settlement', async () => {
    const reputationRoute = await routes.reputation();
    const res = await (reputationRoute.GET as unknown as (r: Request, c: { params: { id: string } }) => Promise<Response>)(
      req('GET'),
      { params: { id: sellerId } },
    );
    const rep = await body(res);
    const components = rep.components as Record<string, unknown>;
    expect(components.seller_settled_count).toBe(1);
    expect(components.pass_rate).toBe(1);
    expect(rep.reputation_score as number).toBeGreaterThan(50);
  });
});
