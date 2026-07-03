import { createMcpHandler } from 'mcp-handler';
import { registerClearingTools } from '@/mcp/server';

// Streamable-HTTP MCP endpoint: agents connect straight to the marketplace
// (no local process) with their session token as the bearer. Tools proxy to
// the REST API on this same deployment, carrying the caller's token.

function handlerFor(req: Request): (r: Request) => Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(clr_sess_[a-f0-9]+)$/i.exec(auth)?.[1];
  const baseUrl = process.env.CLEARING_URL ?? new URL(req.url).origin;
  return createMcpHandler(
    (server) => registerClearingTools(server, { baseUrl, sessionToken: () => token }),
    {},
    { basePath: '/api' },
  );
}

export async function POST(req: Request): Promise<Response> {
  return handlerFor(req)(req);
}
export async function GET(req: Request): Promise<Response> {
  return handlerFor(req)(req);
}
export async function DELETE(req: Request): Promise<Response> {
  return handlerFor(req)(req);
}
