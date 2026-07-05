import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agents, listings, messages, orders } from '@/db/schema';
import { ApiError } from './http';
import { newId } from './ids';
import { emitWebhookEvent } from './webhooks';

// Direct buyer ↔ seller messaging. Any authenticated agent can message any
// other agent; a conversation is the pair of agents (order-scoped context is
// optional). Threads are grouped by a stable `pairKey` = the two ids sorted.

const MAX_BODY = 4000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_URL = 700_000; // ~500KB file as a data: URI
const MAX_ATTACHMENT_NAME = 200;

export interface MessageAttachment {
  name: string;
  /** https:// link or an uploaded file as a data: URI. */
  url: string;
}

/** Stable per-conversation key: the two agent ids, sorted, joined. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function validateAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new ApiError('too_many_attachments', `At most ${MAX_ATTACHMENTS} attachments`, 422);
  }
  for (const a of attachments) {
    if (!a.name?.trim() || a.name.length > MAX_ATTACHMENT_NAME) {
      throw new ApiError('invalid_attachment', 'Each attachment needs a name (≤200 chars)', 422);
    }
    if (!a.url || a.url.length > MAX_ATTACHMENT_URL) {
      throw new ApiError('attachment_too_large', 'Attachment exceeds the ~500KB limit', 413);
    }
    if (!/^(https?:\/\/|data:)/i.test(a.url)) {
      throw new ApiError('invalid_attachment', 'Attachment url must be http(s) or a data: URI', 422);
    }
  }
  return attachments.map((a) => ({ name: a.name.trim(), url: a.url }));
}

export async function sendMessage(
  db: Db,
  args: {
    senderAgentId: string;
    recipientAgentId: string;
    body: string;
    orderId?: string;
    attachments?: MessageAttachment[];
  },
): Promise<{ messageId: string; createdAt: string }> {
  const body = args.body.trim();
  if (!body) throw new ApiError('empty_message', 'Message body is required', 422);
  if (body.length > MAX_BODY) {
    throw new ApiError('message_too_long', `Message exceeds ${MAX_BODY} characters`, 422);
  }
  const attachments = validateAttachments(args.attachments);
  if (args.recipientAgentId === args.senderAgentId) {
    throw new ApiError('self_message', 'An agent cannot message itself', 409);
  }
  const recipient = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, args.recipientAgentId));
  if (!recipient[0]) throw new ApiError('not_found', 'Recipient agent not found', 404);

  // If an order is referenced, the sender must be a party to it (buyer or
  // seller) — you can only pin messages to orders you're actually in.
  if (args.orderId) {
    const rows = await db
      .select({ buyer: orders.buyerAgentId, listingId: orders.listingId })
      .from(orders)
      .where(eq(orders.id, args.orderId));
    if (!rows[0]) throw new ApiError('not_found', 'Order not found', 404);
    const sellerRows = await db
      .select({ seller: listings.sellerAgentId })
      .from(listings)
      .where(eq(listings.id, rows[0].listingId));
    const parties = [rows[0].buyer, sellerRows[0]?.seller].filter(Boolean);
    if (!parties.includes(args.senderAgentId)) {
      throw new ApiError('forbidden', 'You are not a party to that order', 403);
    }
  }

  const messageId = newId('msg');
  const createdAt = new Date();
  await db.insert(messages).values({
    id: messageId,
    pairKey: pairKey(args.senderAgentId, args.recipientAgentId),
    senderAgentId: args.senderAgentId,
    recipientAgentId: args.recipientAgentId,
    orderId: args.orderId,
    body,
    attachments,
    createdAt,
  });

  emitWebhookEvent(db, {
    event: 'message.received',
    agentIds: [args.recipientAgentId],
    payload: {
      message_id: messageId,
      from_agent_id: args.senderAgentId,
      order_id: args.orderId ?? null,
      preview: body.slice(0, 140),
      attachment_count: attachments.length,
    },
  });
  return { messageId, createdAt: createdAt.toISOString() };
}

/**
 * The conversation between the requesting agent and one other agent, oldest
 * first. Reading the thread marks the inbound (unread) messages as read.
 */
export async function getConversation(
  db: Db,
  agentId: string,
  otherAgentId: string,
  opts?: { limit?: number },
): Promise<Array<{
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  mine: boolean;
  order_id: string | null;
  body: string;
  attachments: MessageAttachment[];
  read: boolean;
  created_at: string;
}>> {
  const key = pairKey(agentId, otherAgentId);
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.pairKey, key))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // Mark this agent's inbound unread messages in the thread as read.
  const unreadIds = rows
    .filter((m) => m.recipientAgentId === agentId && m.readAt === null)
    .map((m) => m.id);
  if (unreadIds.length > 0) {
    await db
      .update(messages)
      .set({ readAt: new Date() })
      .where(inArray(messages.id, unreadIds));
  }

  return rows
    .reverse()
    .map((m) => ({
      id: m.id,
      from_agent_id: m.senderAgentId,
      to_agent_id: m.recipientAgentId,
      mine: m.senderAgentId === agentId,
      order_id: m.orderId,
      body: m.body,
      attachments: (m.attachments as MessageAttachment[]) ?? [],
      read: m.recipientAgentId === agentId ? true : m.readAt !== null,
      created_at: m.createdAt.toISOString(),
    }));
}

/**
 * Inbox: the most recent message per conversation the agent is in, with the
 * counterparty and an unread count. Reduced in JS over a recent window so it
 * stays portable across PGlite / Neon / postgres-js.
 */
export async function listConversations(
  db: Db,
  agentId: string,
  opts?: { scan?: number },
): Promise<Array<{
  with_agent_id: string;
  with_name: string;
  last_message: string;
  last_from_me: boolean;
  unread: number;
  updated_at: string;
}>> {
  const scan = Math.min(Math.max(opts?.scan ?? 500, 1), 1000);
  const rows = await db
    .select()
    .from(messages)
    .where(or(eq(messages.senderAgentId, agentId), eq(messages.recipientAgentId, agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(scan);

  const threads = new Map<
    string,
    { other: string; last: (typeof rows)[number]; unread: number }
  >();
  for (const m of rows) {
    const other = m.senderAgentId === agentId ? m.recipientAgentId : m.senderAgentId;
    const t = threads.get(other);
    if (!t) {
      threads.set(other, {
        other,
        last: m,
        unread: m.recipientAgentId === agentId && m.readAt === null ? 1 : 0,
      });
    } else if (m.recipientAgentId === agentId && m.readAt === null) {
      t.unread++;
    }
    // rows are newest-first, so the first seen per thread is the latest.
  }

  const others = [...threads.keys()];
  const names =
    others.length > 0
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, others))
      : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));

  return [...threads.values()]
    .sort((a, b) => b.last.createdAt.getTime() - a.last.createdAt.getTime())
    .map((t) => ({
      with_agent_id: t.other,
      with_name: nameOf.get(t.other) ?? '',
      last_message: t.last.body.slice(0, 200),
      last_from_me: t.last.senderAgentId === agentId,
      unread: t.unread,
      updated_at: t.last.createdAt.toISOString(),
    }));
}

/** Total unread messages across all conversations (for a badge). */
export async function unreadCount(db: Db, agentId: string): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.recipientAgentId, agentId), isNull(messages.readAt)));
  return rows.length;
}
