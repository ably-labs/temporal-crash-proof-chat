// Starts the demo: forks worker processes A and B, each with its own channel pool, and runs the web server, which can
// kill or restart either worker.

import { config, WORKER_NAMES } from './config.js';
import { ensureSandboxApp, usesSandbox } from './sandbox.js';
import { startServer } from './server.js';
import { Supervisor } from './supervisor.js';

/** How often to check that the sandbox app still exists, when the demo runs on one. */
const SANDBOX_CHECK_MS = 30_000;

const created = await ensureSandboxApp();
if (created) console.log(`[main] created sandbox app ${created}, and wrote its key to .env`);

console.log(`[main] Temporal at ${config.temporalAddress}, task queue ${config.taskQueue}`);
console.log(`[main] Ably endpoint ${config.ablyEndpoint ?? 'production'}, model ${config.model}`);

const supervisor = new Supervisor();
supervisor.startAll();
console.log(`[main] started workers ${WORKER_NAMES.join(' and ')}`);

const server = await startServer(supervisor);

// A sandbox app expires after about an hour. When it does, make a new one and restart the workers on its key. The
// server signs browser tokens with the new key from then on; a page open on the old app needs a reload.
async function checkSandbox() {
  try {
    const appId = await ensureSandboxApp();
    if (appId) {
      console.log(`[main] the sandbox app expired: created ${appId}, restarting the workers. Reload the page.`);
      await supervisor.stopAll();
      supervisor.startAll();
    }
  } catch (err) {
    console.error('[main] sandbox check failed', err);
  }
  setTimeout(checkSandbox, SANDBOX_CHECK_MS).unref();
}
if (usesSandbox()) setTimeout(checkSandbox, SANDBOX_CHECK_MS).unref();

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
