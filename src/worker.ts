// One worker process. The supervisor (main.ts) forks two of them, named by WORKER_NAME, and can kill either one to
// show the stream being retried on the other.
//
// Each worker creates one realtime channel pool when it starts, opens it, and injects it into the activities as a
// dependency, so every activity on the worker shares the pool's few connections. The pool is closed once the worker
// has stopped, which waits for publishes still in flight. `AblyHttpPlugin` registers the `ably.*` activities that the
// workflow's discrete Ably calls run as, with an Ably HTTP client of its own.

import { fileURLToPath } from 'node:url';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createRealtimeChannelPool } from '@ably/pubsub-server';
import { AblyHttpPlugin } from '@ably/pubsub-server/temporal';
import { createActivities } from './activities.js';
import { config } from './config.js';
import { loseFirstResponse, loseFirstResponseInterceptor } from './failure-injection.js';
import type { SupervisorMessage, WorkerMessage } from './supervisor-messages.js';

const name = process.env.WORKER_NAME ?? 'A';
const tag = `[worker ${name}]`;

/** Reports to the supervisor, if there is one. */
function report(message: WorkerMessage) {
  process.send?.(message);
}

process.on('message', (message: SupervisorMessage) => {
  if (message.type === 'lose-first-response') {
    loseFirstResponse.clear();
    for (const workflowId of message.workflowIds) loseFirstResponse.add(workflowId);
  }
});

// Checked now rather than on the first turn, so a missing key stops the worker at startup.
void config.anthropicApiKey;

Runtime.install({ logger: new DefaultLogger('WARN') });

// Appends keep Ably's default rollup, which delivers the appends published within 40ms as one. Without it, a burst of
// tokens can exceed a connection's server-to-client message rate (100 a second on a sandbox app), and Ably drops
// messages with a continuity loss on the channel.
const pool = createRealtimeChannelPool(
  { key: config.ablyKey, endpoint: config.ablyEndpoint },
  { size: config.poolSize, failedRetryTimeout: 10_000 },
);
await pool.open();
report({ type: 'pool', state: 'open', size: config.poolSize });
console.log(`${tag} channel pool open: ${config.poolSize} realtime connections`);

const connection = await NativeConnection.connect({ address: config.temporalAddress });
const worker = await Worker.create({
  connection,
  namespace: config.temporalNamespace,
  taskQueue: config.taskQueue,
  // Shown on each activity attempt in the Temporal UI, and read by the server to say which worker ran it.
  identity: `worker-${name}`,
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  activities: createActivities(pool, name),
  plugins: [new AblyHttpPlugin({ clientOptions: { key: config.ablyKey, endpoint: config.ablyEndpoint } })],
  interceptors: { activity: [loseFirstResponseInterceptor] },
  // Without a workflow cache, every workflow task goes to the shared task queue rather than to the worker that ran
  // the last one. Otherwise, after the worker that last ran a turn is killed, the turn's next workflow task waits for
  // the sticky queue's timeout before the other worker can take it.
  maxCachedWorkflows: 0,
  // Send the streaming activity's heartbeats (and the serials they carry) at least every half second, rather than at
  // 80% of its heartbeat timeout, so a retry finds nearly every message the killed attempt published.
  maxHeartbeatThrottleInterval: '500 milliseconds',
});

// Temporal's runtime shuts the worker down on SIGINT and SIGTERM by itself.
report({ type: 'ready' });
console.log(`${tag} polling task queue "${config.taskQueue}" on ${config.temporalAddress}`);
try {
  await worker.run(); // Resolves after shutdown, once the running activities have finished or been cancelled.
} finally {
  await pool.close();
  report({ type: 'pool', state: 'closed', size: config.poolSize });
  await connection.close();
  console.log(`${tag} stopped, channel pool closed`);
  // The supervisor's message listener would otherwise keep the process alive.
  process.disconnect?.();
}
