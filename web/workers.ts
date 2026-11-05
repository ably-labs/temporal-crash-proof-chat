// The worker cards. Each shows the worker process's state and its channel pool, one dot per connection, lit while the
// pool is open, with a ring on the connection carrying the current reply. A button kills the worker, as a crash
// would, or starts it again.

import type { WorkerStatus } from '../src/supervisor.js';
import { STATUS_MESSAGE, type TurnStatus } from '../src/protocol.js';
import type { ConnectionMap } from './connections.js';
import { badge, byId, el, getJson, postJson } from './dom.js';
import { isSummary, replyHeadersOf, type Session } from './session.js';

const POLL_MS = 1000;

interface Card {
  root: HTMLElement;
  badges: HTMLElement;
  pool: HTMLElement;
  button: HTMLButtonElement;
  pid?: number;
}

const STATE_BADGES: Record<WorkerStatus['state'], [string, string]> = {
  starting: ['Starting', 'grey'],
  running: ['Running', 'green'],
  killed: ['Killed', 'orange'],
  exited: ['Stopped', 'grey'],
};

export function createWorkers(session: Session, connections: ConnectionMap) {
  const container = byId('workers');
  const cards = new Map<string, Card>();
  let statuses: WorkerStatus[] = [];

  /** The worker streaming the current reply, and the connection it streams on, while the reply is in progress. */
  let streaming: { worker: string; connectionId?: string } | undefined;
  /** The highest attempt seen for each reply, so a late message from an earlier attempt does not move the ring. */
  const attempts = new Map<string, number>();

  session.decoder.onEvent(({ event, message }) => {
    const headers = replyHeadersOf(message);
    if (!event || !headers || isSummary(message)) return;
    connections.record(headers.worker, message.connectionId);
    if (headers.attempt < (attempts.get(headers.replyId) ?? 0)) return;
    attempts.set(headers.replyId, headers.attempt);
    if (streaming?.worker !== headers.worker || streaming.connectionId !== message.connectionId) {
      streaming = { worker: headers.worker, connectionId: message.connectionId };
      render();
    }
  });

  void session.channel.subscribe(STATUS_MESSAGE, (message) => {
    const { state } = message.data as TurnStatus;
    if (state !== 'thinking' && streaming) {
      streaming = undefined;
      render();
    }
  });

  function card(name: string): Card {
    let card = cards.get(name);
    if (!card) {
      const badges = el('div', { class: 'worker-badges' });
      const pool = el('div', { class: 'pool' });
      const button = el('button', { class: 'button', attrs: { type: 'button' } });
      const root = el(
        'div',
        { class: 'card worker' },
        el('div', { class: 'worker-head' }, el('h3', { text: `Worker ${name}` }), badges),
        pool,
        button,
      );
      button.addEventListener('click', () => void act(name, button));
      card = { root, badges, pool, button };
      cards.set(name, card);
      container.append(root);
    }
    return card;
  }

  async function act(name: string, button: HTMLButtonElement) {
    const status = statuses.find((worker) => worker.name === name);
    const running = status?.state === 'running' || status?.state === 'starting';
    button.disabled = true;
    try {
      statuses = await postJson<WorkerStatus[]>(`/api/workers/${name}/${running ? 'kill' : 'restart'}`);
      render();
    } finally {
      button.disabled = false;
    }
  }

  function render() {
    for (const status of statuses) {
      const view = card(status.name);
      if (status.pid !== undefined && status.pid !== view.pid) {
        // A new process has a new pool, with new connections. A killed worker's connections are kept until then:
        // the retry's deletes carry the connection ID of the messages they delete, which is the killed worker's.
        if (view.pid !== undefined) connections.reset(status.name);
        view.pid = status.pid;
      }

      const [label, tone] = STATE_BADGES[status.state];
      const streamingHere = streaming?.worker === status.name && status.state === 'running';
      view.badges.replaceChildren(
        ...(streamingHere ? [badge('Streaming here', 'violet', true)] : []),
        badge(label, tone, status.state === 'running'),
      );
      view.root.classList.toggle('killed', status.state === 'killed');
      view.root.classList.toggle('streaming', streamingHere);

      const size = status.poolSize ?? 0;
      const carrying = streamingHere ? connections.find(streaming?.connectionId) : undefined;
      const dots = Array.from({ length: size }, (_, i) =>
        el('span', {
          class: `conn${status.poolOpen ? ' open' : ''}${carrying?.index === i + 1 ? ' carrying' : ''}`,
          attrs: { 'aria-hidden': 'true' },
        }),
      );
      const summary = status.poolOpen
        ? `${size} of ${size} open${carrying ? ` · this chat on conn ${carrying.index}` : ''}`
        : `0 of ${size || '?'} open`;
      view.pool.replaceChildren(el('span', { class: 'pool-label', text: 'Pool' }), ...dots, el('span', { class: 'pool-text', text: summary }));
      view.pool.setAttribute('aria-label', `Pool: ${summary}`);

      const running = status.state === 'running' || status.state === 'starting';
      view.button.textContent = `${running ? 'Kill' : 'Restart'} worker ${status.name}`;
    }
  }

  async function poll() {
    try {
      statuses = await getJson<WorkerStatus[]>('/api/workers');
      render();
    } catch (err) {
      console.error('[workers]', err);
    }
    setTimeout(poll, POLL_MS);
  }
  connections.onChange(render);
  void poll();
}
