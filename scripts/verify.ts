// End-to-end check, without a browser. Needs the demo running (`npm start`).
//
// It does what the browser does: enters presence on a new conversation channel, decodes the channel with AI
// Transport's Vercel decoder, publishes a user message and starts a turn. Once the reply is streaming, it kills the
// worker running the stream, waits for the turn to finish on the other worker, and checks that:
//
// - the reply decoded from the last attempt's messages is the text the activity returned
// - every message the killed attempt heartbeated is deleted
// - `thinking` and `complete` each appear once
// - the reply carries the "retried" annotation
//
// The model's text differs between runs, so the checks compare structure and equality, not content.
//
//   npm run verify                          the crash case
//   npm run verify -- --no-kill             a turn with no failure
//   npm run verify -- --lose-first-response  also lose the first response of each plugin write: with idempotent
//                                            publishing, each status still arrives once
//   npm run verify -- --lose-first-response --no-idempotency   ...and without it, each status arrives twice

import { vercelAdaptor, vercelDecoder } from '@ably/ai-transport/vercel';
import { createHttpClient, createRealtimeClient, type InboundMessage } from '@ably/pubsub-server';
import { config } from '../src/config.js';
import type { TurnDescription } from '../src/server.js';
import { RETRIED_ANNOTATION, STATUS_MESSAGE, type TurnStatus } from '../src/protocol.js';
import type { ChatTurnResult } from '../src/workflows.js';

const kill = !process.argv.includes('--no-kill');
const loseFirstResponse = process.argv.includes('--lose-first-response');
const idempotentPublishing = !process.argv.includes('--no-idempotency');
/** A lost response is retried, and only an idempotent retry is discarded by Ably. */
const expectedStatusCopies = loseFirstResponse && !idempotentPublishing ? 2 : 1;
/** How many text deltas of the first attempt to wait for before killing its worker. */
const DELTAS_BEFORE_KILL = 15;
const TURN_TIMEOUT_MS = 180_000;

const server = `http://localhost:${config.port}`;
const clientId = 'verify-user';
const channelName = `${config.channelPrefix}verify-${Date.now()}`;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const headersOf = (message: InboundMessage) =>
  ((message.extras as { headers?: Record<string, unknown> } | undefined)?.headers ?? {}) as Record<string, unknown>;

const realtime = createRealtimeClient({ key: config.ablyKey, endpoint: config.ablyEndpoint, clientId });
const rest = createHttpClient({ key: config.ablyKey, endpoint: config.ablyEndpoint });
const channel = realtime.channels.get(channelName);

// A continuity loss means Ably dropped messages on the way to this client, for example for exceeding the connection's
// message rate, so the decoded reply would be missing text.
const discontinuities: string[] = [];
channel.on('update', (change) => {
  if (!change.resumed) discontinuities.push(change.reason?.message ?? 'unknown reason');
});

// The reply's text per attempt, as the decoder delivered it, and the statuses, as the channel delivered them.
const textByAttempt = new Map<number, string>();
const deltasByAttempt = new Map<number, number>();
const statuses: TurnStatus[] = [];

const decoder = vercelDecoder();
decoder.onEvent(({ event, message }) => {
  // The decoder hands an annotation summary on as the message's whole content, so the "retried" annotation on the
  // reply would count its text twice.
  if (event?.type !== 'text-delta' || message.action === 'message.summary') return;
  const attempt = Number(headersOf(message).attempt);
  textByAttempt.set(attempt, (textByAttempt.get(attempt) ?? '') + event.delta);
  deltasByAttempt.set(attempt, (deltasByAttempt.get(attempt) ?? 0) + 1);
});
decoder.onError((error) => console.error('decode error:', error.message));
await channel.subscribe(decoder.receive);
await channel.subscribe(STATUS_MESSAGE, (message) => statuses.push(message.data as TurnStatus));
await channel.presence.enter();

const userMessage = {
  id: `user-${Date.now()}`,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text: 'Plan me a relaxed three-day trip to Lisbon, with food tips.' }],
};
await vercelAdaptor(channel).send({ type: 'user-message', message: userMessage });
const turn = await api<{ workflowId: string; replyId: string }>('/api/turns', {
  channel: channelName,
  clientId,
  messages: [userMessage],
  loseFirstResponse,
  idempotentPublishing,
});
console.log(`Started ${turn.workflowId} on ${channelName}`);

let killed: string | undefined;
let description: TurnDescription;
try {
  if (kill) {
    const worker = await waitFor('the reply to stream', async () => {
      if ((deltasByAttempt.get(1) ?? 0) < DELTAS_BEFORE_KILL) return undefined;
      const description = await api<TurnDescription>(`/api/turns/${turn.workflowId}`);
      const stream = description.activities.find((activity) => activity.type === 'streamReply');
      return stream?.attempts.find((attempt) => attempt.attempt === 1 && attempt.state === 'running')?.worker;
    });
    killed = worker.replace(/^worker-/, '');
    await api(`/api/workers/${killed}/kill`, {});
    console.log(`Killed worker ${killed} after ${deltasByAttempt.get(1)} text deltas`);
  }

  description = await waitFor(
    'the turn to finish',
    async () => {
      const description = await api<TurnDescription>(`/api/turns/${turn.workflowId}`);
      return description.status === 'RUNNING' ? undefined : description;
    },
    TURN_TIMEOUT_MS,
  );
  await new Promise((resolve) => setTimeout(resolve, 2000)); // Let the last messages arrive.
} finally {
  // Leave both workers running for the next run, however this one ends.
  if (killed) await api(`/api/workers/${killed}/restart`, {});
}

const failures: string[] = [];
function check(ok: boolean, label: string) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
}

check(discontinuities.length === 0, `no continuity loss on the channel${discontinuities.length ? ` (${discontinuities.join('; ')})` : ''}`);
const result = description.result as ChatTurnResult | undefined;
check(description.status === 'COMPLETED' && result?.state === 'complete', `turn completed (${description.status}, ${result?.state ?? description.error})`);
const reply = result?.reply;
if (reply) {
  const decoded = textByAttempt.get(reply.attempt) ?? '';
  let same = 0;
  while (same < decoded.length && decoded[same] === reply.text[same]) same++;
  check(
    decoded === reply.text,
    `decoded attempt ${reply.attempt} matches the activity's text (${reply.text.length} chars` +
      (decoded === reply.text ? ')' : `; decoded ${decoded.length}, first difference at ${same}: ${JSON.stringify(decoded.slice(same, same + 40))})`),
  );

  if (kill) {
    check(reply.attempt > 1, `the reply took more than one attempt (${reply.attempt})`);
    check(reply.worker !== killed, `the last attempt ran on another worker (${reply.worker})`);
    check(reply.deleted.length > 0, `the retry deleted the killed attempt's messages (${reply.deleted.length})`);
    const deleted = await Promise.all(reply.deleted.map((serial) => rest.channels.get(channelName).getMessage(serial)));
    check(deleted.every((message) => message.action === 'message.delete'), 'each of them reads back as deleted');

    // A message the killed attempt published after its last heartbeat is not deleted. The browser still hides it by
    // its attempt header. Reported, not failed: it depends on timing.
    const history = await rest.channels.get(channelName).history({ limit: 1000 });
    const leftOver = history.items.filter(
      (message) => Number(headersOf(message).attempt) < reply.attempt && message.action !== 'message.delete',
    );
    const leftOverSerials = new Set(leftOver.map((message) => message.serial));
    console.log(`     earlier-attempt messages not deleted (published after the last heartbeat): ${leftOverSerials.size}`);

    const annotations = await rest.channels.get(channelName).annotations.get(reply.serial, null);
    check(annotations.items.some((annotation) => annotation.type === RETRIED_ANNOTATION), 'the reply has the "retried" annotation');
  }
}

const ours = statuses.filter((status) => status.replyId === turn.replyId);
const count = (state: string) => ours.filter((status) => status.state === state).length;
for (const state of ['thinking', 'complete']) {
  check(count(state) === expectedStatusCopies, `${expectedStatusCopies} "${state}" status (${count(state)})`);
}

realtime.close();
console.log(failures.length === 0 ? '\nPASS' : `\nFAIL: ${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
