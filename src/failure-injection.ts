// Demo-only failure injection for the workflow's plugin calls: "lose the first REST response". The first attempt of a
// write reaches Ably, then fails as if its response never arrived, so Temporal retries it. With idempotent publishing
// on (the default) the retry carries the same message ID and Ably discards it. With it off, the status is published
// twice.
//
// The supervisor tells every worker which turns to fail this way, since either worker may run a turn's activities.

import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { ActivityInterceptorsFactory } from '@temporalio/worker';

/**
 * The plugin calls the failure applies to. `ably.channel.appendMessage` would be left out on purpose, since Ably
 * applies a retried append again, and the streaming activity is a different kind of failure (kill a worker for that).
 */
const INJECTABLE_ACTIVITIES = new Set(['ably.channel.publish', 'ably.channel.annotations.publish']);

/** The workflow IDs whose first attempt at each plugin write is failed after it reached Ably. */
export const loseFirstResponse = new Set<string>();

export const loseFirstResponseInterceptor: ActivityInterceptorsFactory = (ctx: Context) => ({
  inbound: {
    async execute(input, next) {
      const { activityType, attempt, workflowExecution } = ctx.info;
      const result = await next(input);
      if (
        attempt === 1 &&
        INJECTABLE_ACTIVITIES.has(activityType) &&
        workflowExecution &&
        loseFirstResponse.has(workflowExecution.workflowId)
      ) {
        throw ApplicationFailure.retryable(
          `Demo failure injection: the request reached Ably, but its response was lost. Temporal will retry ${activityType}.`,
          'DemoLostResponse',
        );
      }
      return result;
    },
  },
});
