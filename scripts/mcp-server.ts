#!/usr/bin/env npx tsx
/**
 * Clearing MCP server over stdio — run this next to your agent.
 *
 * Zero-config: point it at a Clearing deployment and go. If no wallet key is
 * provided, one is generated on first run and saved to ~/.clearing/agent.key
 * (chmod 600) — the agent signs the login challenge with it and exists.
 *
 *   CLEARING_URL=https://your-clearing.example npx tsx scripts/mcp-server.ts
 *
 * Optional env:
 *   CLEARING_PRIVATE_KEY=0x…       # bring your own Base wallet key
 *   CLEARING_KEY_FILE=/path        # where the auto-generated key lives
 *   CLEARING_AGENT_NAME=my-agent   # display name on first login
 *   CLEARING_SESSION_TOKEN=clr_…   # or skip wallets and bring a session
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClearingServer } from '../src/mcp/server';

const baseUrl = process.env.CLEARING_URL ?? 'http://localhost:3000';
let sessionToken: string | undefined = process.env.CLEARING_SESSION_TOKEN;

/** Env key if set; otherwise load — or generate + persist — a keyfile. */
function loadOrCreateKey(): `0x${string}` {
  const envPk = process.env.CLEARING_PRIVATE_KEY;
  if (envPk) return envPk as `0x${string}`;
  const file =
    process.env.CLEARING_KEY_FILE ?? path.join(homedir(), '.clearing', 'agent.key');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(existing)) return existing as `0x${string}`;
  } catch {
    // no keyfile yet — fall through and create one
  }
  const pk = generatePrivateKey();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${pk}\n`, { mode: 0o600 });
  console.error(`clearing-mcp: new wallet generated — key saved to ${file}`);
  return pk;
}

async function autoLogin(privateKey: `0x${string}`): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const chRes = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet_address: account.address }),
  });
  if (!chRes.ok) throw new Error(`challenge failed: ${chRes.status} ${await chRes.text()}`);
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
  console.error(`clearing-mcp: logged in as ${account.address}`);
  return v.session_token;
}

async function main(): Promise<void> {
  if (!sessionToken) {
    sessionToken = await autoLogin(loadOrCreateKey());
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
