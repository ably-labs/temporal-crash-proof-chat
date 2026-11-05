// Creates a throwaway app on the Ably sandbox, the way the SDK's integration tests do, and writes its key and the
// sandbox endpoint to .env. Sandbox apps expire on their own, so run this again if the key stops working.
//
// The app has a `mutable` namespace with mutable messages enabled, which the chat channels (`mutable:chat-*`) need
// for appends, deletes and annotations.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PROJECT_DIR } from './config.js';

const SANDBOX_HOST = 'sandbox.realtime.ably-nonprod.net';

const response = await fetch(`https://${SANDBOX_HOST}/apps`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    keys: [{}],
    namespaces: [{ id: 'mutable', mutableMessages: true }],
  }),
  signal: AbortSignal.timeout(30_000),
});

if (!response.ok) {
  console.error(`Sandbox provisioning failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}

const app = (await response.json()) as { appId: string; keys: { keyStr: string }[] };

// Keep any other settings already in .env, and replace the Ably ones.
const envPath = `${PROJECT_DIR}/.env`;
const kept = existsSync(envPath)
  ? readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((line) => line && !/^(ABLY_KEY|ABLY_ENDPOINT)=/.test(line))
  : [];
writeFileSync(envPath, [...kept, `ABLY_KEY=${app.keys[0].keyStr}`, 'ABLY_ENDPOINT=nonprod:sandbox', ''].join('\n'));

console.log(`Created sandbox app ${app.appId}, and wrote ABLY_KEY and ABLY_ENDPOINT to ${envPath}`);
