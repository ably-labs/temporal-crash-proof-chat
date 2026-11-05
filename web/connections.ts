// Which worker's pool connection published a message. The pool has no API that lists its connections, so the page
// learns them from the reply's messages: each carries the `connectionId` it was published on and a `worker` header.
// A worker's connections are numbered in the order the page first sees them.

export class ConnectionMap {
  private readonly byWorker = new Map<string, string[]>();
  private readonly listeners = new Set<() => void>();

  /** Records that `worker` published on `connectionId`. */
  record(worker: string, connectionId: string | undefined) {
    if (!connectionId) return;
    const connections = this.byWorker.get(worker) ?? [];
    if (connections.includes(connectionId)) return;
    connections.push(connectionId);
    this.byWorker.set(worker, connections);
    for (const listener of this.listeners) listener();
  }

  /** Forgets a worker's connections, for when its process has restarted with a new pool. */
  reset(worker: string) {
    this.byWorker.delete(worker);
  }

  /** The worker and 1-based connection number that published on `connectionId`. */
  find(connectionId: string | undefined): { worker: string; index: number } | undefined {
    if (!connectionId) return undefined;
    for (const [worker, connections] of this.byWorker) {
      const index = connections.indexOf(connectionId);
      if (index >= 0) return { worker, index: index + 1 };
    }
    return undefined;
  }

  /** A short label such as `B·2`, for the log. */
  label(connectionId: string | undefined): string | undefined {
    const found = this.find(connectionId);
    return found && `${found.worker}·${found.index}`;
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }
}
