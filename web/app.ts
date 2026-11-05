// The browser app: layout option A. It loads the demo's settings, then wires up each panel.

import type { DemoConfig } from './config.js';
import { createChat } from './chat.js';
import { byId, getJson } from './dom.js';
import { createSession } from './session.js';

const config = await getJson<DemoConfig>('/api/config');

byId<HTMLAnchorElement>('temporal-ui-link').href =
  `${config.temporalUiUrl}/namespaces/${encodeURIComponent(config.namespace)}/workflows`;
const temporalBadge = byId('temporal-badge');
temporalBadge.lastChild!.textContent = `Temporal ${new URL(config.temporalUiUrl).hostname}`;
temporalBadge.classList.add('ok');
byId('ably-badge').lastChild!.textContent = `Ably ${config.endpoint ?? 'production'}`;

const session = await createSession(config);
const ablyBadge = byId('ably-badge');
session.client.connection.on((change) => {
  ablyBadge.classList.toggle('ok', change.current === 'connected');
  ablyBadge.classList.toggle('bad', change.current !== 'connected' && change.current !== 'connecting');
});

createChat(session, {
  onTurnStarted() {},
});
