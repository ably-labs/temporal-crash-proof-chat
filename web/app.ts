// The browser app: layout option A. It loads the demo's settings, then wires up each panel.

import type { DemoConfig } from './config.js';
import { byId, getJson } from './dom.js';

const config = await getJson<DemoConfig>('/api/config');

byId<HTMLAnchorElement>('temporal-ui-link').href =
  `${config.temporalUiUrl}/namespaces/${encodeURIComponent(config.namespace)}/workflows`;
const temporalBadge = byId('temporal-badge');
temporalBadge.lastChild!.textContent = `Temporal ${new URL(config.temporalUiUrl).hostname}`;
temporalBadge.classList.add('ok');
byId('ably-badge').lastChild!.textContent = `Ably ${config.endpoint ?? 'production'}`;
