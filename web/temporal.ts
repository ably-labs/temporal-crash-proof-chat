// What Temporal recorded for the current turn: one row per activity attempt, with the worker that ran it and how it
// ended. A killed worker's streaming attempt shows as a heartbeat timeout, and its retry as running on the other one.

import type { ActivityAttempt, TurnActivity, TurnDescription } from '../src/server.js';
import type { Turn } from './chat.js';
import { byId, el, getJson } from './dom.js';

const POLL_MS = 700;

function describeFailure(failure: string | undefined): string {
  if (!failure) return 'failed';
  if (/heartbeat/i.test(failure)) return 'heartbeat timeout';
  if (/lost/i.test(failure)) return 'response lost';
  if (/model failed/i.test(failure)) return 'model failed';
  return failure.length > 40 ? `${failure.slice(0, 40)}…` : failure;
}

function stateText(activity: TurnActivity, attempt: ActivityAttempt): string {
  switch (attempt.state) {
    case 'completed':
      return 'done';
    case 'running':
      return 'running';
    case 'failed':
      return describeFailure(attempt.failure);
    case 'scheduled':
      return activity.attempts.length > 1 ? 'retrying' : 'scheduled';
  }
}

function detailText(activity: TurnActivity, attempt: ActivityAttempt): string {
  if (activity.type === 'streamReply') return `attempt ${attempt.attempt} · vercelAdaptor.pipeEach`;
  const detail = activity.detail ?? '';
  return activity.attempts.length > 1 ? `${detail} · attempt ${attempt.attempt}` : detail;
}

export function createTemporalPanel() {
  const list = byId<HTMLOListElement>('activities');
  const link = byId<HTMLAnchorElement>('turn-link');
  let current: Turn | undefined;

  function render(description: TurnDescription) {
    const rows = description.activities.flatMap((activity) =>
      activity.attempts.map((attempt) =>
        el(
          'li',
          { class: `activity ${attempt.state}` },
          el('span', { class: 'state-dot', attrs: { 'aria-hidden': 'true' } }),
          el(
            'span',
            { class: 'name' },
            activity.type,
            ' ',
            el('span', { class: 'detail', text: detailText(activity, attempt) }),
          ),
          el('span', { class: 'where', text: attempt.worker?.replace(/^worker-/, 'worker ') ?? '' }),
          el('span', { class: 'state', text: stateText(activity, attempt), attrs: { title: attempt.failure ?? '' } }),
        ),
      ),
    );
    list.replaceChildren(...rows);
  }

  async function poll(turn: Turn) {
    if (turn !== current) return;
    try {
      const description = await getJson<TurnDescription>(`/api/turns/${encodeURIComponent(turn.workflowId)}`);
      if (turn !== current) return;
      render(description);
      if (description.status !== 'RUNNING') return;
    } catch (err) {
      console.error('[temporal]', err);
    }
    setTimeout(() => void poll(turn), POLL_MS);
  }

  return {
    show(turn: Turn) {
      current = turn;
      link.href = turn.temporalUrl;
      link.textContent = turn.workflowId.slice(0, 13);
      link.title = `${turn.workflowId} in the Temporal UI`;
      list.replaceChildren(el('li', { class: 'placeholder', text: 'Starting the turn…' }));
      void poll(turn);
    },
  };
}
