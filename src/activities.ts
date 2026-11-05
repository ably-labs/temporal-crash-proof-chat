// The streaming activity. It does not create an Ably client: the worker creates one realtime channel pool when it
// starts and injects it here, so every concurrent activity on the worker shares the pool's few connections.
//
// The reply is published with AI Transport's Vercel adaptor, which opens a message on a stream's first delta and
// appends each later delta to it. Every write carries `replyId`, `attempt` and `worker` headers, so a subscriber can
// tell the attempts at one reply apart.
//
// A retried attempt cannot continue the failed attempt's messages, since the model will not regenerate the same
// text. So it deletes them, finding their serials in the failed attempt's heartbeat details, and streams the reply
// again as new messages. The browser replaces the reply when it sees a higher attempt.

import { Context, log } from '@temporalio/activity';
import type { UIMessage } from 'ai';
import { vercelAdaptor } from '@ably/ai-transport/vercel';
import type { RealtimeChannelPool } from '@ably/pubsub-server';
import { streamModelReply } from './model.js';

export interface StreamReplyInput {
  /** The conversation's channel. */
  channel: string;
  /** The reply's ID, the same on every attempt. */
  replyId: string;
  /** The conversation so far, oldest first, ending with the user's message. */
  messages: UIMessage[];
}

export interface StreamReplyResult {
  /** The serial of the message the reply's text was streamed into. */
  serial: string;
  /** The serial of every message this attempt published for the reply. */
  serials: string[];
  /** The serials of an earlier attempt's messages, which this attempt deleted. */
  deleted: string[];
  attempt: number;
  /** The name of the worker that ran this attempt. */
  worker: string;
  /** The reply's text, as the model generated it. */
  text: string;
}

/**
 * What the activity records in its heartbeat: the messages on the channel that a retry must delete. Temporal keeps the
 * last details an attempt recorded, so a retry that dies before it heartbeats hands the same list on to the next.
 */
interface StreamProgress {
  serials: string[];
}

export function createActivities(pool: RealtimeChannelPool, worker: string) {
  return {
    async streamReply({ channel: name, replyId, messages }: StreamReplyInput): Promise<StreamReplyResult> {
      const context = Context.current();
      const { attempt } = context.info;

      // Stops the model call when the pipe ends for any reason, as well as when Temporal cancels the activity: a pipe
      // that fails releases the model's stream without cancelling it, which would leave the call running.
      const abort = new AbortController();
      const signal = AbortSignal.any([context.cancellationSignal, abort.signal]);

      // A publish-only handle on the channel, released when this function returns or throws.
      using channel = pool.get(name);

      // The messages on the channel that a retry must delete: the earlier attempt's that are not yet deleted, then
      // this attempt's own. Heartbeating it on a timer, rather than only as events arrive, keeps a live worker from
      // timing out while it deletes or while the model is slow to start (the AI SDK retries an overloaded provider for
      // several seconds before the first chunk), so only a dead worker misses the 5 second heartbeat timeout.
      const previous = (context.info.heartbeatDetails as StreamProgress | undefined)?.serials ?? [];
      const serials = [...previous];
      const progress = (): StreamProgress => ({ serials });
      context.heartbeat(progress());
      const heartbeat = setInterval(() => context.heartbeat(progress()), 1000);

      try {
        for (const serial of previous) {
          await channel.deleteMessage({ serial }, { description: `Replaced by attempt ${attempt} on worker ${worker}` });
          serials.splice(serials.indexOf(serial), 1);
          context.heartbeat(progress());
        }
        if (previous.length > 0) {
          log.info('Deleted the previous attempt', { replyId, attempt, deleted: previous.length });
        }

        const stream = await streamModelReply(messages, replyId, signal);
        let serial: string | undefined;
        let text = '';
        for await (const published of vercelAdaptor(channel).pipeEach(stream, {
          signal,
          headers: { replyId, attempt, worker },
        })) {
          if (published.serial && !serials.includes(published.serial)) {
            serials.push(published.serial);
            // Temporal throttles heartbeats (the worker sends at most one per 500ms), so this is cheap.
            context.heartbeat(progress());
          }
          if (published.event.type === 'text-delta') {
            serial ??= published.serial;
            text += published.event.delta;
          }
        }

        if (!serial) {
          throw new Error('The model replied with no text');
        }
        return { serial, serials, deleted: previous, attempt, worker, text };
      } finally {
        clearInterval(heartbeat);
        abort.abort();
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
