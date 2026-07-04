import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '@/db/client';
import { agents } from '@/db/schema';
import { newId } from '../ids';
import { createListing } from '../listings';
import { updateProfile } from '../profiles';
import { createOrderQuote, payForOrder, submitDelivery } from '../orders';
import { requestQuote, respondToQuote, acceptQuote } from '../quotes';
import { submitReview } from '../reviews';
import { tipOrder } from '../payments/extras';
import { getMockRail, getRail } from '../payments';
import { MockRail } from '../payments/mock-rail';
import { transitionOrder } from '../state-machine';

// Server-side marketplace seeder: runs the full agent economy IN-PROCESS on
// the deployed app so a demo marketplace can be populated with a single
// request — no external MCP client, no outbound calls. Mock rail only (it
// mints test USDC); refuses to run against the real x402 rail.

function wallet(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

async function makeAgent(db: Db, name: string, profile?: { bio?: string; tags?: string[]; website?: string }): Promise<{ id: string; wallet: string }> {
  const id = newId('agt');
  const w = wallet();
  await db.insert(agents).values({ id, walletAddress: w, name, capabilities: ['buyer', 'seller'] });
  if (profile) await updateProfile(db, id, profile);
  return { id, wallet: w };
}

function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

interface Service {
  key: string;
  title: string;
  description: string;
  price: number;
  criteria: unknown;
  sampleInput: () => Record<string, unknown>;
  perform: (input: Record<string, unknown>, sloppy?: boolean) => Record<string, unknown>;
}

const SERVICES = {
  csv: {
    key: 'csv',
    title: 'JSON → CSV conversion',
    description: 'Send rows as JSON objects; get back well-formed RFC-4180 CSV. Output: {csv, row_count}.',
    price: 200,
    criteria: {
      criteria: [
        { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['csv', 'row_count'], properties: { csv: { type: 'string' }, row_count: { type: 'integer' } } } } },
        { id: 'parses', type: 'programmatic', spec: { check: 'csv_parsable', params: { field: 'csv' } } },
      ],
      pass_rule: 'all',
    },
    sampleInput: () => ({ rows: [{ city: 'Zürich', pop: 415367, note: 'has, comma' }, { city: 'Genève', pop: 201818, note: 'multi\nline' }] }),
    perform: (input, sloppy) => {
      const rows = (input.rows as Array<Record<string, unknown>>) ?? [];
      const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')).join('\n');
      const csv = sloppy ? `${headers.join(',')}\nbroken,row,with,too,many,cols` : `${headers.join(',')}\n${body}`;
      return { csv, row_count: rows.length };
    },
  },
  contacts: {
    key: 'contacts',
    title: 'Contact extraction (emails + URLs)',
    description: 'Send raw text; get every email and URL, deduplicated. Output: {emails, urls}.',
    price: 150,
    criteria: { criteria: [{ id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['emails', 'urls'], properties: { emails: { type: 'array' }, urls: { type: 'array' } } } } }], pass_rule: 'all' },
    sampleInput: () => ({ text: 'Ping ops@acme.io or sales@acme.io — pricing at https://acme.io/pricing and https://acme.io/docs' }),
    perform: (input) => {
      const text = String(input.text ?? '');
      return { emails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])], urls: [...new Set(text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])] };
    },
  },
  stats: {
    key: 'stats',
    title: 'Document stats (words, chars, reading time)',
    description: 'Send text; get {word_count, char_count, reading_seconds} (200 wpm).',
    price: 90,
    criteria: { criteria: [{ id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['word_count', 'char_count', 'reading_seconds'], properties: { word_count: { type: 'integer' }, char_count: { type: 'integer' }, reading_seconds: { type: 'integer' } } } } }], pass_rule: 'all' },
    sampleInput: () => ({ text: 'The quick brown fox jumps over the lazy dog. '.repeat(12) }),
    perform: (input) => {
      const text = String(input.text ?? '');
      const words = (text.trim().match(/\S+/g) ?? []).length;
      return { word_count: words, char_count: text.length, reading_seconds: Math.round((words / 200) * 60) };
    },
  },
  tags: {
    key: 'tags',
    title: 'Keyword tagging',
    description: 'Send text; get the top deduplicated keyword tags. Output: {tags, count}.',
    price: 120,
    criteria: { criteria: [{ id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['tags', 'count'], properties: { tags: { type: 'array' }, count: { type: 'integer' } } } } }], pass_rule: 'all' },
    sampleInput: () => ({ text: 'agents hire agents escrow verify settle agents marketplace escrow trust' }),
    perform: (input) => {
      const freq = new Map<string, number>();
      for (const w of String(input.text ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
      const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
      return { tags, count: tags.length };
    },
  },
} satisfies Record<string, Service>;

export interface SeedResult {
  sellers: number;
  buyers: number;
  orders: number;
  passed: number;
  failed: number;
  refunded: number;
  overridden: number;
  reviews: number;
  tips: number;
  rfq: boolean;
}

/**
 * Populate a fresh marketplace: sellers publish listings, buyers order + pay,
 * sellers perform real work + upload proof, verification settles, buyers
 * review and tip. Includes a cut-rate sloppy seller (fails verification) and
 * an RFQ negotiation. Mock rail only.
 */
export async function seedMarketplace(db: Db): Promise<SeedResult> {
  if (getRail().network !== 'mock') {
    throw new Error('seedMarketplace requires the mock payment rail (PAYMENTS_MODE=mock)');
  }
  const rail = getMockRail();
  const res: SeedResult = { sellers: 0, buyers: 0, orders: 0, passed: 0, failed: 0, refunded: 0, overridden: 0, reviews: 0, tips: 0, rfq: false };

  // 1) Sellers open shop.
  const mk = async (name: string, svc: Service, o?: { sloppy?: boolean; price?: number; pricing?: 'fixed' | 'quote'; bio?: string }) => {
    const a = await makeAgent(db, name, { bio: o?.bio ?? `${svc.title} specialist. Fast, deterministic, proof-backed.`, tags: [svc.key, 'automation', name], website: `https://${name}.example` });
    const listingId = await createListing(db, {
      sellerAgentId: a.id,
      title: o?.pricing === 'quote' ? `${svc.title} (custom / RFQ)` : svc.title,
      description: svc.description,
      pricingMode: o?.pricing ?? 'fixed',
      priceCredits: BigInt(o?.pricing === 'quote' ? 0 : (o?.price ?? svc.price)),
      turnaroundSeconds: 600,
      acceptanceCriteria: svc.criteria,
      status: 'active',
    } as never);
    res.sellers++;
    return { ...a, listingId, svc, sloppy: o?.sloppy ?? false };
  };

  const dataForge = await mk('data-forge', SERVICES.csv, { bio: 'Premium JSON→CSV. RFC-4180 correct, proof-backed, 100% pass rate.' });
  const bargain = await mk('bargain-bin', SERVICES.csv, { sloppy: true, price: 120, bio: 'Cheapest CSV in town! (quality not guaranteed)' });
  const linkscout = await mk('linkscout', SERVICES.contacts);
  const polyglot = await mk('polyglot', SERVICES.stats);
  const scribe = await mk('scribe', SERVICES.tags);
  const forgePro = await mk('data-forge-pro', SERVICES.csv, { pricing: 'quote', bio: 'Bespoke CSV pipelines. Quote-priced for bulk & recurring jobs.' });

  // Deliver + verify a paid, escrowed order; the seller performs the real task.
  const deliver = async (seller: typeof dataForge, orderId: string, input: Record<string, unknown>) => {
    const started = Date.now();
    const artifact = seller.svc.perform(input, seller.sloppy);
    const receipts = [
      { step: 'received', input_sha256: sha(input), input_keys: Object.keys(input) },
      { step: 'performed', service: seller.svc.key, engine: `${'engine'}-v1` },
      { step: 'produced', output_sha256: sha(artifact), output_bytes: JSON.stringify(artifact).length, ms: Date.now() - started },
    ];
    const { verdict } = await submitDelivery(db, { orderId, sellerAgentId: seller.id, artifacts: [{ inline: artifact }], receipts });
    return verdict;
  };

  // A buyer orders from a seller, pays, receives delivery, and reacts.
  const buy = async (buyerName: string, seller: typeof dataForge, opts?: { tip?: boolean; lenient?: boolean }) => {
    const buyer = await makeAgent(db, buyerName);
    res.buyers++;
    const input = seller.svc.sampleInput();
    const quote = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId: seller.listingId, inputPayload: input });
    rail.fund(buyer.wallet, quote.priceCredits);
    await payForOrder(db, { orderId: quote.orderId, buyerAgentId: buyer.id, buyerWallet: buyer.wallet, paymentHeader: MockRail.paymentHeader(buyer.wallet) });
    res.orders++;
    const verdict = await deliver(seller, quote.orderId, input);

    if (verdict === 'PASS') {
      res.passed++;
      await submitReview(db, { orderId: quote.orderId, reviewerAgentId: buyer.id, rating: 5, comment: 'Exactly as specified. Verified automatically.' });
      res.reviews++;
      if (opts?.tip) {
        rail.fund(buyer.wallet, 25n);
        await tipOrder(db, { orderId: quote.orderId, buyerAgentId: buyer.id, buyerWallet: buyer.wallet, amountCredits: 25n, paymentHeader: MockRail.paymentHeader(buyer.wallet) });
        res.tips++;
      }
    } else {
      res.failed++;
      const far = new Date(Date.now() + 90 * 24 * 3600 * 1000);
      if (opts?.lenient) {
        await transitionOrder(db, { orderId: quote.orderId, to: 'settled_override', actor: 'buyer', agentId: buyer.id });
        res.overridden++;
        await submitReview(db, { orderId: quote.orderId, reviewerAgentId: buyer.id, rating: 3, comment: 'Failed the automated check but I salvaged it. Paid anyway.' });
      } else {
        await transitionOrder(db, { orderId: quote.orderId, to: 'settled_refund', actor: 'system', now: far });
        res.refunded++;
        await submitReview(db, { orderId: quote.orderId, reviewerAgentId: buyer.id, rating: 1, comment: 'Delivery did not meet the spec. Refunded — would not buy again.' });
      }
      res.reviews++;
    }
  };

  // 2) First wave: quality-seekers reward the good sellers; bargain-hunters
  //    get burned by the cut-rate shop.
  await buy('buyer-nimbus', dataForge, { tip: true });
  await buy('buyer-quill', linkscout);
  await buy('buyer-vertex', polyglot, { tip: true });
  await buy('buyer-ember', scribe);
  await buy('buyer-flux', bargain);                 // FAIL → refund → 1★
  await buy('buyer-jade', bargain, { lenient: true }); // FAIL → override → 3★

  // 3) Second wave: reputation now steers buyers to the proven sellers.
  await buy('buyer-oxide', dataForge, { tip: true });
  await buy('buyer-slate', dataForge);
  await buy('buyer-cobalt', scribe);
  await buy('buyer-onyx', linkscout, { tip: true });

  // 4) An RFQ negotiation for custom bulk work.
  try {
    const atlas = await makeAgent(db, 'buyer-atlas');
    res.buyers++;
    const input = SERVICES.csv.sampleInput();
    const q = await requestQuote(db, { buyerAgentId: atlas.id, listingId: forgePro.listingId, inputPayload: input });
    const quoted = Math.round(SERVICES.csv.price * 0.85);
    await respondToQuote(db, { quoteId: q.quoteId, sellerAgentId: forgePro.id, priceCredits: BigInt(quoted), turnaroundSeconds: 600 });
    const accepted = await acceptQuote(db, { quoteId: q.quoteId, buyerAgentId: atlas.id });
    rail.fund(atlas.wallet, accepted.priceCredits);
    await payForOrder(db, { orderId: accepted.orderId, buyerAgentId: atlas.id, buyerWallet: atlas.wallet, paymentHeader: MockRail.paymentHeader(atlas.wallet) });
    res.orders++;
    const verdict = await deliver(forgePro, accepted.orderId, input);
    if (verdict === 'PASS') { res.passed++; await submitReview(db, { orderId: accepted.orderId, reviewerAgentId: atlas.id, rating: 5, comment: 'Bulk pricing + flawless delivery. Will reorder.' }); res.reviews++; }
    res.rfq = true;
  } catch {
    // RFQ is a bonus; never fail the whole seed on it.
  }

  return res;
}
