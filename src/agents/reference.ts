import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Shared plumbing for the reference agents: connect to the Clearing MCP
// stdio server with a wallet key (auto-login), plus the deterministic
// "brains" of the in-house seller services. These double as documentation
// for how any agent integrates.

export interface AgentHandle {
  client: Client;
  wallet: string;
  privateKey: `0x${string}`;
  close: () => Promise<void>;
}

export async function connectAgent(opts: {
  baseUrl: string;
  privateKey?: `0x${string}`;
  name?: string;
}): Promise<AgentHandle> {
  const privateKey = opts.privateKey ?? generatePrivateKey();
  const wallet = privateKeyToAccount(privateKey).address.toLowerCase();
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'scripts/mcp-server.ts'],
    env: {
      ...process.env as Record<string, string>,
      CLEARING_URL: opts.baseUrl,
      CLEARING_PRIVATE_KEY: privateKey,
      ...(opts.name ? { CLEARING_AGENT_NAME: opts.name } : {}),
    },
  });
  const client = new Client({ name: opts.name ?? 'reference-agent', version: '1.0.0' });
  await client.connect(transport);
  return { client, wallet, privateKey, close: () => client.close() };
}

export async function tool<T = Record<string, unknown>>(
  handle: AgentHandle,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T & { status: number }> {
  const result = await handle.client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(content?.text ?? '{}') as T & { status: number };
}

/** Mock-rail X-PAYMENT payload (dev/CI). On the real rail agents use an
 * x402 client (e.g. x402-fetch) to produce this from the 402 requirements. */
export function mockPaymentPayload(wallet: string): string {
  return Buffer.from(
    JSON.stringify({ payer: wallet.toLowerCase(), nonce: Math.random().toString(16).slice(2) }),
  ).toString('base64');
}

// ---------------------------------------------------------------------------
// In-house seller service implementations (machine-verifiable on purpose)
// ---------------------------------------------------------------------------

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');
}

function extractContacts(text: string): { emails: string[]; urls: string[] } {
  return {
    emails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])],
    urls: [...new Set(text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])],
  };
}

function summarizeWithCitations(document: string): {
  summary: string;
  citations: string[];
} {
  const sections = document
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentences = sections.map((s, i) => {
    const first = s.split(/(?<=[.!?])\s/)[0] ?? s;
    return `${first} [§${i + 1}]`;
  });
  return {
    summary: sentences.join(' '),
    citations: sections.map((_, i) => `§${i + 1}`),
  };
}

/** Produce the deliverable for one of the in-house services. */
export function performService(
  listingTitle: string,
  inputPayload: Record<string, unknown>,
): { artifact: Record<string, unknown>; receipts: Array<Record<string, unknown>> } {
  const started = new Date().toISOString();
  const title = listingTitle.toLowerCase();
  if (title.includes('csv')) {
    const rows = (inputPayload.rows ?? []) as Array<Record<string, unknown>>;
    return {
      artifact: { csv: toCsv(rows), row_count: rows.length },
      receipts: [
        { step: 'parsed input rows', count: rows.length, at: started },
        { step: 'serialized csv', at: new Date().toISOString() },
      ],
    };
  }
  if (title.includes('contact')) {
    const text = String(inputPayload.text ?? '');
    const contacts = extractContacts(text);
    return {
      artifact: { ...contacts, source_length: text.length },
      receipts: [
        { step: 'scanned text for emails/urls', chars: text.length, at: started },
        { step: 'deduplicated results', at: new Date().toISOString() },
      ],
    };
  }
  if (title.includes('summar')) {
    const document = String(inputPayload.document ?? '');
    const result = summarizeWithCitations(document);
    return {
      artifact: result,
      receipts: [
        { step: 'split document into sections', at: started },
        { step: 'summarized each section with citation', at: new Date().toISOString() },
      ],
    };
  }
  throw new Error(`No implementation for listing: ${listingTitle}`);
}

/** The three in-house seed listings — machine-verifiable services. */
export const SEED_LISTINGS = [
  {
    title: 'JSON → CSV conversion',
    description:
      'Send rows as JSON objects, get back well-formed CSV. Input: {"rows": [{...}]}. Output artifact: {"csv": "...", "row_count": n}.',
    price_credits: 200,
    turnaround_seconds: 900,
    acceptance_criteria: {
      criteria: [
        {
          id: 'has-csv',
          type: 'schema',
          spec: {
            json_schema: {
              type: 'object',
              required: ['csv', 'row_count'],
              properties: { csv: { type: 'string' }, row_count: { type: 'integer' } },
            },
          },
        },
        {
          id: 'csv-parses',
          type: 'programmatic',
          spec: { check: 'csv_parsable', params: { field: 'csv' } },
        },
      ],
      pass_rule: 'all',
    },
  },
  {
    title: 'Contact extraction (emails + URLs)',
    description:
      'Send raw text, get every email address and URL, deduplicated. Input: {"text": "..."}. Output artifact: {"emails": [], "urls": []}.',
    price_credits: 150,
    turnaround_seconds: 900,
    acceptance_criteria: {
      criteria: [
        {
          id: 'shape',
          type: 'schema',
          spec: {
            json_schema: {
              type: 'object',
              required: ['emails', 'urls'],
              properties: {
                emails: { type: 'array', items: { type: 'string' } },
                urls: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        {
          id: 'emails-valid',
          type: 'programmatic',
          spec: { check: 'regex_match', params: { pattern: '^\\[\\]$|@', field: 'emails' } },
        },
      ],
      pass_rule: 'all',
    },
  },
  {
    title: 'Summarization with citations',
    description:
      'Send a document, get a summary where every sentence cites its source section. Input: {"document": "..."}. Output artifact: {"summary": "...", "citations": ["§1", ...]}.',
    price_credits: 500,
    turnaround_seconds: 1800,
    acceptance_criteria: {
      criteria: [
        {
          id: 'shape',
          type: 'schema',
          spec: {
            json_schema: {
              type: 'object',
              required: ['summary', 'citations'],
              properties: {
                summary: { type: 'string', minLength: 10 },
                citations: { type: 'array', minItems: 1 },
              },
            },
          },
        },
        {
          id: 'faithful',
          type: 'judged',
          spec: {
            requirement:
              'The summary faithfully reflects the input document and every citation refers to a section that exists in the input.',
            rubric:
              'FAIL if the summary invents claims not present in the document, or cites sections that do not exist.',
          },
        },
      ],
      pass_rule: 'all',
    },
  },
] as const;
