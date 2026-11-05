// The page's Ably session: one realtime client with a clientId, one conversation channel per page load, a presence
// entry (the turn checks it before running the model), and AI Transport's Vercel decoder on the channel. Every panel
// reads the channel through this session.

import type { Delivery } from '@ably/ai-transport';
import { type VercelEvent, vercelDecoder } from '@ably/ai-transport/vercel';
import { createClient } from '@ably/pubsub-device';
import type { DemoConfig } from './config.js';

export type ReplyDelivery = Delivery<VercelEvent>;

/** The headers the streaming activity puts on every write of a reply. */
export interface ReplyHeaders {
  replyId: string;
  attempt: number;
  worker: string;
}

/** The reply headers on a delivered message, or undefined for a message that is not part of a reply. */
export function replyHeadersOf(message: { extras?: unknown }): ReplyHeaders | undefined {
  const headers = (message.extras as { headers?: Record<string, unknown> } | undefined)?.headers;
  if (!headers || typeof headers.replyId !== 'string') return undefined;
  return { replyId: headers.replyId, attempt: Number(headers.attempt), worker: String(headers.worker) };
}

/**
 * Whether a delivery is an annotation summary. The decoder hands a `message.summary` on as if it were the message's
 * content, so the "retried" annotation on a reply would otherwise decode as its whole text again.
 */
export function isSummary(message: { action?: string }): boolean {
  return message.action === 'message.summary';
}

const shortId = () => crypto.randomUUID().slice(0, 8);

export async function createSession(config: DemoConfig) {
  const clientId = `user-${shortId()}`;
  const channelName = `${config.channelPrefix}${shortId()}`;

  const client = createClient({
    authUrl: `${location.origin}/api/auth`,
    authParams: { clientId, channel: channelName },
    clientId,
    endpoint: config.endpoint ?? undefined,
  });
  const channel = client.channels.get(channelName);
  const decoder = vercelDecoder();
  decoder.onError((error) => console.error('[decoder]', error));
  await channel.subscribe(decoder.receive);
  await channel.presence.enter();

  return { client, channel, channelName, clientId, decoder };
}

export type Session = Awaited<ReturnType<typeof createSession>>;
