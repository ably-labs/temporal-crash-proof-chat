// Settings shared by the workers, the web server and the verify script. Values come from the environment, and from a
// `.env` file in the project directory if there is one (`pnpm setup:sandbox` writes it).

import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

try {
  process.loadEnvFile(`${PROJECT_DIR}/.env`);
} catch {
  // No .env file: rely on the environment.
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env and set it.`);
    process.exit(1);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a whole number, 1 or more.`);
    process.exit(1);
  }
  return value;
}

/** The two worker processes the supervisor runs. Killing the one that is streaming makes Temporal retry on the other. */
export const WORKER_NAMES = ['A', 'B'] as const;
export type WorkerName = (typeof WORKER_NAMES)[number];

export const config = {
  /** Read lazily, so that a process that does not need the key does not ask for it. Never printed. */
  get ablyKey(): string {
    return required('ABLY_KEY');
  },
  /**
   * For example `nonprod:sandbox`, which a sandbox key needs. Unset means production. Read lazily, like the key, since
   * `pnpm start` replaces both when the sandbox app expires.
   */
  get ablyEndpoint(): string | undefined {
    return process.env.ABLY_ENDPOINT || undefined;
  },
  /** Checked by the workers at startup, since only they call the model. */
  get anthropicApiKey(): string {
    return required('ANTHROPIC_API_KEY');
  },
  model: process.env.MODEL || 'claude-sonnet-5-5',
  /** The number of realtime connections in each worker's channel pool. */
  poolSize: positiveInteger('POOL_SIZE', 3),
  /**
   * Each conversation gets its own channel, named with this prefix. The namespace needs message appends, deletes and
   * annotations enabled (a `mutableMessages` rule). The `ai` namespace has one in a sandbox app the demo creates, and
   * in an app created in the dashboard for AI Transport.
   */
  channelPrefix: process.env.CHANNEL_PREFIX ?? 'ai:chat-',
  port: positiveInteger('PORT', 4300),
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  temporalUiUrl: process.env.TEMPORAL_UI_URL ?? 'http://localhost:8233',
  taskQueue: process.env.TASK_QUEUE ?? 'crash-proof-chat',
};

/** The Temporal UI page for a workflow run's event history. */
export function temporalUiUrl(workflowId: string, runId: string): string {
  return `${config.temporalUiUrl}/namespaces/${encodeURIComponent(config.temporalNamespace)}/workflows/${encodeURIComponent(workflowId)}/${runId}/history`;
}
