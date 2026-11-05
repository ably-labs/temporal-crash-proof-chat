// Runs the worker processes, and kills or restarts one on request. Killing is a SIGKILL, so the worker gets no chance
// to finish or hand back its activities: Temporal only notices when the streaming activity's heartbeat times out.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKER_NAMES, type WorkerName } from './config.js';
import type { WorkerMessage } from './supervisor-messages.js';

const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url));

export type ProcessState = 'starting' | 'running' | 'killed' | 'exited';

/** What the supervisor knows about one worker process. */
export interface WorkerStatus {
  name: WorkerName;
  /** The worker's Temporal identity, as each activity attempt it runs records. */
  identity: string;
  state: ProcessState;
  pid?: number;
  /** The number of realtime connections in the worker's channel pool. */
  poolSize?: number;
  /** Whether the worker's channel pool is open. A killed worker's connections drop with its process. */
  poolOpen: boolean;
}

interface WorkerProcess {
  status: WorkerStatus;
  child?: ChildProcess;
}

export class Supervisor {
  private readonly workers = new Map<WorkerName, WorkerProcess>();

  constructor() {
    for (const name of WORKER_NAMES) {
      this.workers.set(name, { status: { name, identity: `worker-${name}`, state: 'exited', poolOpen: false } });
    }
  }

  /** Starts every worker that is not running. */
  startAll() {
    for (const name of WORKER_NAMES) this.start(name);
  }

  list(): WorkerStatus[] {
    return [...this.workers.values()].map(({ status }) => ({ ...status }));
  }

  has(name: string): name is WorkerName {
    return this.workers.has(name as WorkerName);
  }

  /** Starts the worker if it is not running. */
  start(name: WorkerName) {
    const worker = this.workers.get(name)!;
    if (worker.child) return;

    const child = fork(WORKER_PATH, {
      env: { ...process.env, WORKER_NAME: name },
      execArgv: ['--import', 'tsx'],
    });
    worker.child = child;
    worker.status = { ...worker.status, state: 'starting', pid: child.pid, poolOpen: false };

    child.on('message', (message: WorkerMessage) => {
      if (worker.child !== child) return;
      if (message.type === 'ready') {
        worker.status.state = 'running';
      } else if (message.type === 'pool') {
        worker.status.poolOpen = message.state === 'open';
        worker.status.poolSize = message.size;
      }
    });
    child.on('exit', (code, signal) => {
      if (worker.child !== child) return;
      worker.child = undefined;
      worker.status = {
        ...worker.status,
        state: worker.status.state === 'killed' ? 'killed' : 'exited',
        pid: undefined,
        poolOpen: false,
      };
      console.log(`[supervisor] worker ${name} exited (${signal ?? `code ${code}`})`);
    });
  }

  /** Kills the worker at once, as a crash would. */
  kill(name: WorkerName) {
    const worker = this.workers.get(name)!;
    if (!worker.child) return;
    worker.status.state = 'killed';
    worker.child.kill('SIGKILL');
    console.log(`[supervisor] killed worker ${name}`);
  }

  /** Stops every worker gracefully, and resolves once they have exited. */
  async stopAll() {
    await Promise.all(
      [...this.workers.values()].map(({ child }) => {
        if (!child || child.exitCode !== null) return;
        return new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        });
      }),
    );
  }
}
