#!/usr/bin/env npx tsx
/**
 * Clearing MCP server over stdio — run this next to your agent.
 *
 *   CLEARING_URL=https://your-clearing.example \
 *   CLEARING_PRIVATE_KEY=0x… \        # Base wallet key: auto-login (optional)
 *   CLEARING_SESSION_TOKEN=clr_sess_… # or bring an existing session
 *   npx tsx scripts/mcp-server.ts
 *
 * With CLEARING_PRIVATE_KEY set, the server signs the wallet challenge and
 * logs in automatically before serving tools. Identity = wallet.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createClearingServer } from '../src/mcp/server';

const baseUrl = process.env.CLEARING_URL ?? 'http://localhost:3000';
let sessionToken: string | undefined = process.env.CLEARING_SESSION_TOKEN;

async function autoLogin(privateKey: `0x${string}`): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const chRes = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet_address: account.address }),
  });
  const ch = (await chRes.json()) as { nonce: string; message: string };
  const signature = await account.signMessage({ message: ch.message });
  const vRes = await fetch(`${baseUrl}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wallet_address: account.address,
      nonce: ch.nonce,
      signature,
      name: process.env.CLEARING_AGENT_NAME,
    }),
  });
  if (!vRes.ok) throw new Error(`auto-login failed: ${vRes.status} ${await vRes.text()}`);
  const v = (await vRes.json()) as { session_token: string };
  return v.session_token;
}

async function main(): Promise<void> {
  const pk = process.env.CLEARING_PRIVATE_KEY;
  if (!sessionToken && pk) {
    sessionToken = await autoLogin(pk as `0x${string}`);
    console.error('clearing-mcp: wallet login ok');
  }
  const server = createClearingServer({
    baseUrl,
    sessionToken: () => sessionToken,
    setSessionToken: (t) => (sessionToken = t),
  });
  await server.connect(new StdioServerTransport());
  console.error(`clearing-mcp: serving tools for ${baseUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
