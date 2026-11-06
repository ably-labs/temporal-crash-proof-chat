// Creates a sandbox app and writes its key and the sandbox endpoint to .env. `npm start` does this itself when there's
// no key or the sandbox app has expired, so this is only needed to make a new app by hand.

import { createSandboxApp } from './sandbox.js';

const appId = await createSandboxApp();
console.log(`Created sandbox app ${appId}, and wrote ABLY_KEY and ABLY_ENDPOINT to .env`);
