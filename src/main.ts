// Starts the demo: forks worker processes A and B, each with its own channel pool, and runs the web server, which can
// kill or restart either worker.

import { config, WORKER_NAMES } from './config.js';
import { startServer } from './server.js';
import { Supervisor } from './supervisor.js';

console.log(`[main] Temporal at ${config.temporalAddress}, task queue ${config.taskQueue}`);
console.log(`[main] Ably endpoint ${config.ablyEndpoint ?? 'production'}, model ${config.model}`);

const supervisor = new Supervisor();
supervisor.startAll();
console.log(`[main] started workers ${WORKER_NAMES.join(' and ')}`);

const server = await startServer(supervisor);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('[main] shutting down');
  await Promise.all([supervisor.stopAll(), server.close()]);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
