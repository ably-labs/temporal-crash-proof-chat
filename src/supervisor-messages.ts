// The IPC messages between the supervisor (main.ts) and its worker processes (worker.ts).

/** From a worker to the supervisor. */
export type WorkerMessage =
  /** The worker has created its Temporal worker and is about to poll. */
  | { type: 'ready' }
  /** The worker's channel pool has opened or closed. */
  | { type: 'pool'; state: 'open' | 'closed'; size: number };

/** From the supervisor to a worker. */
export type SupervisorMessage =
  /** Every workflow ID whose plugin writes should lose their first response, replacing the worker's set. */
  { type: 'lose-first-response'; workflowIds: string[] };
