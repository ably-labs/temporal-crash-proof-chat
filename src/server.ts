// The demo web server. It serves the browser app, issues Ably token requests to the browser (the API key never leaves
// the server), starts chat turns with a Temporal client, reports each turn's activities from Temporal, and kills or
// restarts the worker processes on request.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client, Connection, WorkflowFailedError, type WorkflowHandle } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { createHttpClient } from '@ably/pubsub-server';
import { config, PROJECT_DIR, temporalUiUrl, WORKER_NAMES } from './config.js';
import type { Supervisor } from './supervisor.js';
import type { ChatTurnInput } from './workflows.js';

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'web/index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'web/style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/app.js.map': { file: 'public/app.js.map', type: 'application/json' },
};

/** A channel name the browser may use: one conversation channel under the configured prefix. */
function isChatChannel(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(config.channelPrefix) && /^[\w:-]+$/.test(name);
}

export interface TurnRequest {
  channel: string;
  clientId: string;
  messages: ChatTurnInput['messages'];
  /**
   * The reply's ID, if the browser chose one. Choosing it lets the browser match the reply's first messages to the turn
   * even if they arrive before this request's response.
   */
  replyId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function startServer(supervisor: Supervisor) {
  const connection = await Connection.connect({ address: config.temporalAddress });
  const temporal = new Client({ connection, namespace: config.temporalNamespace });
  const observed = new AttemptObservations();

  // Only used to sign token requests for the browser. Signing happens locally, without a request to Ably.
  const ably = createHttpClient({ key: config.ablyKey, endpoint: config.ablyEndpoint });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      const { file, type } = STATIC_FILES[url.pathname];
      try {
        const body = await readFile(`${PROJECT_DIR}/${file}`);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body);
      } catch {
        json(res, 404, { error: `${file} is missing. Start the demo with \`npm start\`, which builds it.` });
      }
      return;
    }

    if (route === 'GET /api/config') {
      return json(res, 200, {
        channelPrefix: config.channelPrefix,
        endpoint: config.ablyEndpoint ?? null,
        model: config.model,
        poolSize: config.poolSize,
        workers: WORKER_NAMES,
        temporalUiUrl: config.temporalUiUrl,
        namespace: config.temporalNamespace,
        taskQueue: config.taskQueue,
      });
    }

    // The browser's authUrl. A token for the browser's clientId, limited to its conversation's channel. It can publish
    // the user's messages, and needs presence so the turn can see that the user is there.
    if (route === 'GET /api/auth') {
      const channel = url.searchParams.get('channel');
      if (!isChatChannel(channel)) {
        return json(res, 400, { error: `channel must start with ${config.channelPrefix}` });
      }
      const tokenRequest = await ably.auth.createTokenRequest({
        clientId: url.searchParams.get('clientId') || 'user',
        capability: { [channel]: ['publish', 'subscribe', 'presence', 'history'] },
      });
      return json(res, 200, tokenRequest);
    }

    if (route === 'POST /api/turns') {
      const body = JSON.parse(await readBody(req)) as Partial<TurnRequest>;
      if (!isChatChannel(body.channel) || typeof body.clientId !== 'string' || !Array.isArray(body.messages)) {
        return json(res, 400, { error: 'Expected { channel, clientId, messages, replyId? }' });
      }
      if (body.replyId !== undefined && !UUID.test(body.replyId)) {
        return json(res, 400, { error: 'replyId must be a lowercase UUID' });
      }
      const replyId = body.replyId ?? randomUUID();
      const workflowId = `turn-${replyId}`;
      const input: ChatTurnInput = {
        channel: body.channel,
        clientId: body.clientId,
        replyId,
        messages: body.messages,
      };
      const handle = await temporal.workflow.start('chatTurn', { taskQueue: config.taskQueue, workflowId, args: [input] });
      console.log(`[server] started ${workflowId} on ${body.channel}`);
      return json(res, 200, {
        workflowId,
        runId: handle.firstExecutionRunId,
        replyId,
        temporalUrl: temporalUiUrl(workflowId, handle.firstExecutionRunId),
      });
    }

    const turn = /^\/api\/turns\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && turn) {
      const workflowId = decodeURIComponent(turn[1]);
      return json(res, 200, await describeTurn(temporal.workflow.getHandle(workflowId), observed));
    }

    if (route === 'GET /api/workers') {
      return json(res, 200, supervisor.list());
    }

    const workerAction = /^\/api\/workers\/([^/]+)\/(kill|restart)$/.exec(url.pathname);
    if (req.method === 'POST' && workerAction) {
      const [, name, action] = workerAction;
      if (!supervisor.has(name)) {
        return json(res, 404, { error: `No worker ${name}` });
      }
      if (action === 'kill') supervisor.kill(name);
      else supervisor.start(name);
      return json(res, 200, supervisor.list());
    }

    json(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[server]', err);
      if (!res.headersSent) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[server] demo UI on http://localhost:${config.port}`);

  return {
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await connection.close();
    },
  };
}

export type AttemptState = 'scheduled' | 'running' | 'completed' | 'failed';

/** One attempt at an activity. */
export interface ActivityAttempt {
  attempt: number;
  state: AttemptState;
  /** The worker that ran the attempt, from its Temporal identity, such as `worker-A`. */
  worker?: string;
  /** Why the attempt failed, such as a heartbeat timeout. */
  failure?: string;
}

/** One activity the turn scheduled, with each of its attempts. */
export interface TurnActivity {
  activityId: string;
  type: string;
  summary?: string;
  /** What the call did, from its recorded input, such as `agent.status: thinking · id 33fad0cf…:0`. */
  detail?: string;
  attempts: ActivityAttempt[];
}

export interface TurnDescription {
  status: string;
  activities: TurnActivity[];
  result?: unknown;
  error?: string;
}

/**
 * Temporal's history records only the last attempt of an activity, when it ends, so the worker that ran an earlier
 * attempt is gone from it. The server remembers which worker it saw running each attempt, from the pending
 * activities it reads while the turn runs.
 */
class AttemptObservations {
  private readonly workers = new Map<string, string>();

  record(workflowId: string, activityId: string, attempt: number, worker: string) {
    this.workers.set(`${workflowId}/${activityId}/${attempt}`, worker);
  }

  worker(workflowId: string, activityId: string, attempt: number): string | undefined {
    return this.workers.get(`${workflowId}/${activityId}/${attempt}`);
  }
}

// temporal.api.enums.v1.PendingActivityState
const PENDING_ACTIVITY_STARTED = 2;

/** A turn's status, each activity attempt it has made, and its result once it has closed. */
async function describeTurn(handle: WorkflowHandle, observed: AttemptObservations): Promise<TurnDescription> {
  const description = await handle.describe();
  const status = description.status.name;
  const events = (await handle.fetchHistory()).events ?? [];

  const activities = new Map<string, TurnActivity>();
  const byScheduledEvent = new Map<string, TurnActivity>();
  const lastAttempt = (activity: TurnActivity) => activity.attempts[activity.attempts.length - 1];

  for (const event of events) {
    const scheduled = event.activityTaskScheduledEventAttributes;
    const started = event.activityTaskStartedEventAttributes;
    const completed = event.activityTaskCompletedEventAttributes;
    const failed = event.activityTaskFailedEventAttributes;
    const timedOut = event.activityTaskTimedOutEventAttributes;

    if (scheduled) {
      const summary = event.userMetadata?.summary;
      const activity: TurnActivity = {
        activityId: scheduled.activityId ?? String(event.eventId),
        type: scheduled.activityType?.name ?? '?',
        summary: summary ? String(defaultPayloadConverter.fromPayload(summary)) : undefined,
        detail: describeInput(scheduled.input?.payloads?.[0]),
        attempts: [{ attempt: 1, state: 'scheduled' }],
      };
      activities.set(activity.activityId, activity);
      byScheduledEvent.set(String(event.eventId), activity);
    } else if (started) {
      const activity = byScheduledEvent.get(String(started.scheduledEventId));
      if (activity) {
        // Only the attempt that ended is in the history. Every earlier attempt failed, the last of them with
        // `lastFailure`.
        activity.attempts = attemptsBefore(started.attempt ?? 1, started.lastFailure?.message ?? undefined);
        activity.attempts.push({ attempt: started.attempt ?? 1, state: 'running', worker: started.identity ?? undefined });
      }
    } else if (completed || failed || timedOut) {
      const activity = byScheduledEvent.get(String((completed ?? failed ?? timedOut)!.scheduledEventId));
      if (activity) {
        const attempt = lastAttempt(activity);
        attempt.state = completed ? 'completed' : 'failed';
        if (!completed) {
          const failure = (failed ?? timedOut)!.failure;
          attempt.failure = failure?.cause?.message ?? failure?.message ?? undefined;
        }
      }
    }
  }

  // An activity in progress is only recorded in the history once it ends, so its attempts come from the pending
  // activities instead.
  for (const pending of description.raw.pendingActivities ?? []) {
    const activity = activities.get(pending.activityId ?? '');
    if (!activity) continue;
    const attempt = pending.attempt ?? 1;
    const running = pending.state === PENDING_ACTIVITY_STARTED;
    activity.attempts = attemptsBefore(attempt, pending.lastFailure?.message ?? undefined);
    activity.attempts.push({
      attempt,
      state: running ? 'running' : 'scheduled',
      worker: running ? (pending.lastWorkerIdentity ?? undefined) : undefined,
    });
    if (running && pending.lastWorkerIdentity) {
      observed.record(handle.workflowId, activity.activityId, attempt, pending.lastWorkerIdentity);
    }
  }

  for (const activity of activities.values()) {
    for (const attempt of activity.attempts) {
      attempt.worker ??= observed.worker(handle.workflowId, activity.activityId, attempt.attempt);
    }
  }

  let result: unknown;
  let error: string | undefined;
  if (status === 'COMPLETED') {
    result = await handle.result();
  } else if (status === 'FAILED') {
    try {
      await handle.result();
    } catch (err) {
      error = err instanceof WorkflowFailedError ? (err.cause?.message ?? err.message) : String(err);
    }
  }

  return { status, activities: [...activities.values()], result, error };
}

/**
 * Describes a plugin call from its recorded input: the messages it published, with the ID the plugin derived for
 * each (the same on every attempt, which is what lets Ably discard a retry), or the annotation it added.
 */
function describeInput(payload: Parameters<typeof defaultPayloadConverter.fromPayload>[0] | undefined): string | undefined {
  if (!payload) return undefined;
  const input = defaultPayloadConverter.fromPayload(payload) as {
    messages?: { name?: string; data?: { state?: string }; id?: string }[];
    annotation?: { type?: string };
  };
  const shortId = (id: string | undefined) => (id ? ` · id ${id.replace(/^(.{8}).*(:\d+)$/, '$1…$2')}` : '');
  if (input.messages) {
    return input.messages
      .map((message) => `${message.name}${message.data?.state ? `: ${message.data.state}` : ''}${shortId(message.id)}`)
      .join(', ');
  }
  if (input.annotation?.type) return input.annotation.type;
  return undefined;
}

/** The failed attempts before `attempt`, the last of which failed with `lastFailure`. */
function attemptsBefore(attempt: number, lastFailure: string | undefined): ActivityAttempt[] {
  return Array.from({ length: attempt - 1 }, (_, i) => ({
    attempt: i + 1,
    state: 'failed' as const,
    failure: i === attempt - 2 ? lastFailure : undefined,
  }));
}

function json(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8') || '{}';
}
