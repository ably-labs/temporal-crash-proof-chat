// What Ably sees: every message on the conversation's channel as the decoder hands it on, whether or not it decodes to
// an AI Transport event, with counters above it. Each row shows the action, the AI Transport event, the attempt and
// the pool connection that published it. Earlier attempts' rows are greyed, and the retry's deletes are highlighted.

import { RETRIED_ANNOTATION, STATUS_MESSAGE, type TurnStatus } from '../src/protocol.js';
import type { ConnectionMap } from './connections.js';
import { byId, el } from './dom.js';
import { replyHeadersOf, type ReplyDelivery, type Session } from './session.js';

const MAX_ROWS = 200;
const SNIPPET = 32;

interface Metric {
  value: HTMLElement;
  context: HTMLElement;
}

interface Row {
  root: HTMLElement;
  action: HTMLElement;
  data: HTMLElement;
  conn: HTMLElement;
  /** The connection that published the row's message, while it is not yet known to belong to a worker. */
  unknownConnection?: string;
  serial?: string;
  appends: number;
  replyId?: string;
  attempt?: number;
}

const quote = (text: string) => JSON.stringify(text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text);

export function createAblyLog(session: Session, connections: ConnectionMap) {
  const log = byId('log');
  const metricsEl = byId('metrics');

  function metric(label: string, accent = false): Metric {
    const value = el('span', { class: 'value', text: '0' });
    const context = el('span', { class: 'context' });
    metricsEl.append(el('div', { class: `metric${accent ? ' accent' : ''}` }, el('span', { class: 'label', text: label }), value, context));
    return { value, context };
  }
  const bubbles = metric('Reply bubbles', true);
  const statusCount = metric('Status messages');
  const appendCount = metric('Appends');
  const attemptCount = metric('Attempts');

  const replyIds = new Set<string>();
  /** The highest attempt seen per reply. */
  const attempts = new Map<string, number>();
  /** The reply and attempt each serial belongs to, to label its deletes. */
  const serials = new Map<string, { replyId: string; attempt: number }>();
  let statuses = 0;
  let appends = 0;
  let deletes = 0;
  let lastMessage: unknown;
  const rows: Row[] = [];

  log.append(el('div', { class: 'placeholder', text: 'Messages on the channel appear here.' }));

  function addRow(action: string, data: string, connectionId: string | undefined, className: string, extra: Partial<Row> = {}) {
    if (rows.length === 0) log.replaceChildren();
    const actionEl = el('span', { class: 'action', text: action });
    const dataEl = el('span', { class: 'data', text: data, attrs: { title: data } });
    const label = connections.label(connectionId);
    const conn = el('span', { class: 'conn-label', text: label ?? (connectionId ? '?' : 'REST') });
    const root = el('div', { class: `log-row ${className}` }, actionEl, dataEl, conn);
    const row: Row = { root, action: actionEl, data: dataEl, conn, appends: 0, ...extra };
    if (connectionId && !label) row.unknownConnection = connectionId;
    rows.push(row);
    log.append(root);
    if (rows.length > MAX_ROWS) rows.shift()!.root.remove();
    log.scrollTop = log.scrollHeight;
    return row;
  }

  /** Greys the rows of a reply's earlier attempts once a later one starts. */
  function markSuperseded(replyId: string, current: number) {
    for (const row of rows) {
      if (row.replyId === replyId && row.attempt !== undefined) {
        row.root.classList.toggle('superseded', row.attempt < current);
        row.root.classList.toggle('current', row.attempt === current);
      }
    }
  }

  function updateMetrics() {
    bubbles.value.textContent = String(replyIds.size);
    statusCount.value.textContent = String(statuses);
    appendCount.value.textContent = String(appends);
    const latest = [...attempts.values()].at(-1) ?? 0;
    attemptCount.value.textContent = String(latest);
    attemptCount.context.textContent = deletes > 0 ? `${deletes} earlier message${deletes === 1 ? '' : 's'} deleted` : '';
  }

  session.decoder.onEvent(({ event, message }: ReplyDelivery) => {
    // A message that decodes to several events is one row.
    if (message === lastMessage) return;
    lastMessage = message;
    const action = message.action ?? 'message.create';
    const headers = replyHeadersOf(message);

    if (action === 'message.delete') {
      deletes++;
      const of = message.serial ? serials.get(message.serial) : undefined;
      addRow(action, `attempt ${of?.attempt ?? '?'} message, serial from its heartbeat`, message.connectionId, 'deleted');
    } else if (action === 'message.summary') {
      const retried = (message as { annotations?: { summary?: Record<string, unknown> } }).annotations?.summary?.[
        RETRIED_ANNOTATION
      ];
      addRow(action, retried ? 'annotation · retried, on the reply' : 'annotation summary', message.connectionId, 'status');
    } else if (message.name === STATUS_MESSAGE) {
      statuses++;
      addRow(action, `agent.status: ${(message.data as TurnStatus).state}`, message.connectionId, 'status');
    } else if (event?.type === 'user-message') {
      addRow(action, 'ai · user-message', undefined, '');
      log.lastElementChild!.querySelector('.conn-label')!.textContent = 'you';
    } else if (headers) {
      replyIds.add(headers.replyId);
      if (message.serial) serials.set(message.serial, headers);
      const newAttempt = headers.attempt > (attempts.get(headers.replyId) ?? 0);
      if (newAttempt) {
        attempts.delete(headers.replyId); // Keep the latest reply last.
        attempts.set(headers.replyId, headers.attempt);
      }
      const delta = event?.type === 'text-delta' ? ` ${quote(event.delta)}` : '';
      const data = `ai · ${event?.type ?? '?'}${delta} · attempt ${headers.attempt}`;
      const last = rows.at(-1);
      if (action === 'message.append') {
        appends++;
        if (last && last.serial === message.serial && last.appends > 0) {
          last.appends++;
          last.action.textContent = `message.append ×${last.appends}`;
          last.data.textContent = data;
        } else {
          addRow(action, data, message.connectionId, '', { ...headers, serial: message.serial, appends: 1 });
        }
      } else {
        addRow(action, data, message.connectionId, '', { ...headers, serial: message.serial });
      }
      markSuperseded(headers.replyId, attempts.get(headers.replyId)!);
    } else {
      addRow(action, message.name ?? '', message.connectionId, '');
    }
    updateMetrics();
  });
  // A retry's deletes arrive before the reply messages that identify the retrying worker's connection, so label them
  // once it is known.
  connections.onChange(() => {
    for (const row of rows) {
      const label = row.unknownConnection && connections.label(row.unknownConnection);
      if (label) {
        row.conn.textContent = label;
        row.unknownConnection = undefined;
      }
    }
  });
  updateMetrics();
}
