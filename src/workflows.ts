// The chat turn. Its discrete Ably calls (a presence check, status messages and an annotation) go through
// `TemporalAblyHttpClient`, which runs each one as an `ably.*` activity on the worker, so each is recorded in the
// workflow history and retried without being duplicated. The streamed reply is the one thing workflow code cannot
// do, so it runs as the `streamReply` activity, which publishes through the worker's channel pool.
//
// Workflow code stays deterministic: it never touches the network, and every value it branches on is an activity
// result recorded in the history. It imports nothing from AI Transport or the AI SDK at runtime.

import { ActivityFailure, log, proxyActivities } from '@temporalio/workflow';
import { TemporalAblyHttpClient } from '@ably/pubsub-server/temporal/workflow';
import type { UIMessage } from 'ai';
import type { Activities, StreamReplyResult } from './activities.js';
import {
  AGENT_CLIENT_ID,
  RETRIED_ANNOTATION,
  STATUS_MESSAGE,
  type RetriedAnnotation,
  type TurnState,
  type TurnStatus,
} from './protocol.js';

// Ably deduplicates a retried call only within its deduplication window (2 minutes), so the retries are capped with a
// `scheduleToCloseTimeout` that keeps every attempt inside it.
const activityOptions = {
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '90 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 5 },
};

// The default: every publish and annotation gets an ID derived from the workflow's random stream, so it is the same on
// every attempt and every replay, and Ably discards a retry.
const ably = new TemporalAblyHttpClient({ activityOptions });

// For the "idempotent publishing" toggle only: without it, a retried publish gets a new message ID from the worker's
// client, so Ably cannot tell that it is a retry, and a lost response shows up as a duplicated status.
const ablyWithoutIdempotency = new TemporalAblyHttpClient({ activityOptions, idempotentPublishing: false });

const { streamReply } = proxyActivities<Activities>({
  summary: 'Stream the reply through the channel pool',
  startToCloseTimeout: '5 minutes',
  // The activity heartbeats as it streams, so a dead worker is noticed within 5 seconds and the stream is retried on
  // the other worker.
  heartbeatTimeout: '5 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 1, maximumAttempts: 3 },
});

export interface ChatTurnInput {
  channel: string;
  /** The user's `clientId`. The turn only runs the model while the user is present on the channel. */
  clientId: string;
  replyId: string;
  /** The conversation so far, oldest first, ending with the user's message. */
  messages: UIMessage[];
  /** False to publish the status messages without idempotency, for the failure injection toggle. */
  idempotentPublishing?: boolean;
}

export interface ChatTurnResult {
  state: Exclude<TurnState, 'thinking'>;
  reply?: StreamReplyResult;
}

export async function chatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const channel = ably.channels.get(input.channel);
  const statusChannel = (input.idempotentPublishing === false ? ablyWithoutIdempotency : ably).channels.get(
    input.channel,
  );
  const publishStatus = (state: TurnState, attempts?: number) =>
    statusChannel.publish({
      name: STATUS_MESSAGE,
      data: { replyId: input.replyId, state, attempts } satisfies TurnStatus,
      clientId: AGENT_CLIENT_ID,
    });

  // The branch is decided by the recorded presence result, so a replay takes the same branch.
  const present = await channel.presence.get({ clientId: input.clientId });
  if (present.items.length === 0) {
    await publishStatus('user-offline');
    return { state: 'user-offline' };
  }

  await publishStatus('thinking');

  let reply: StreamReplyResult;
  try {
    reply = await streamReply({ channel: input.channel, replyId: input.replyId, messages: input.messages });
  } catch (err) {
    if (!(err instanceof ActivityFailure)) throw err;
    log.warn('Every attempt at the reply failed', { replyId: input.replyId, error: err.cause?.message });
    await publishStatus('failed');
    return { state: 'failed' };
  }

  if (reply.attempt > 1) {
    await channel.annotations.publish(reply.serial, {
      type: RETRIED_ANNOTATION,
      clientId: AGENT_CLIENT_ID,
      data: { attempts: reply.attempt, worker: reply.worker } satisfies RetriedAnnotation,
    });
  }

  await publishStatus('complete', reply.attempt);
  return { state: 'complete', reply };
}
