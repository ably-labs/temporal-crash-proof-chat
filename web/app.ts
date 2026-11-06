// The browser app: layout option A. It loads the demo's settings, then wires up each panel.

import { createAblyLog } from './ably-log.js';
import type { DemoConfig } from './config.js';
import { createChat } from './chat.js';
import { ConnectionMap } from './connections.js';
import { byId, getJson } from './dom.js';
import { createSession } from './session.js';
import { createTemporalPanel } from './temporal.js';
import { createWorkers } from './workers.js';

const config = await getJson<DemoConfig>('/api/config');

byId<HTMLAnchorElement>('temporal-ui-link').href =
  `${config.temporalUiUrl}/namespaces/${encodeURIComponent(config.namespace)}/workflows`;
const temporalBadge = byId('temporal-badge');
temporalBadge.lastChild!.textContent = `Temporal ${new URL(config.temporalUiUrl).hostname}`;
temporalBadge.classList.add('ok');
const ablyBadge = byId('ably-badge');
const ablyLabel = `Ably ${config.endpoint ?? 'production'}`;
ablyBadge.lastChild!.textContent = ablyLabel;

const session = await createSession(config);
const showConnection = (state: string) => {
  ablyBadge.classList.toggle('ok', state === 'connected');
  ablyBadge.classList.toggle('bad', state !== 'connected' && state !== 'connecting');
  // A failed connection doesn't recover by itself. With a sandbox app, it usually means the app expired and the demo
  // has made a new one, which a reload picks up.
  ablyBadge.lastChild!.textContent = state === 'failed' ? `${ablyLabel} · reload the page` : ablyLabel;
};
showConnection(session.client.connection.state);
session.client.connection.on((change) => showConnection(change.current));

const connections = new ConnectionMap();
createWorkers(session, connections);
createAblyLog(session, connections);

const temporal = createTemporalPanel();

createChat(session, {
  onTurnStarted(turn) {
    temporal.show(turn);
  },
});
