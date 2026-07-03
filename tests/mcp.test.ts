import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClearingServer } from '@/mcp/server';

// The MCP server is the marketplace's front door — verify every spec tool is
// registered and callable (transport-level smoke test; behavior is covered by
// the REST tests the tools proxy to).

const SPEC_TOOLS = [
  'auth_challenge',
  'auth_verify',
  'search_listings',
  'get_listing',
  'create_order',
  'pay_order',
  'get_order',
  'list_my_orders',
  'submit_delivery',
  'override_accept',
  'appeal',
  'create_listing',
  'update_listing',
  'get_balance',
  'get_reputation',
  'register_webhook',
  'get_evidence_pack',
];

describe('MCP server', () => {
  it('exposes every marketplace tool over the protocol', async () => {
    const server = createClearingServer({ baseUrl: 'http://unused.local' });
    const client = new Client({ name: 'test-agent', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const tool of SPEC_TOOLS) {
      expect(names, `missing tool ${tool}`).toContain(tool);
    }
    // Every tool ships a schema and a description an agent can act on.
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
    }
    await client.close();
  });
});
