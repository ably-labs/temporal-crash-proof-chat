// Throwaway apps on the Ably sandbox, made the way the SDK's integration tests make them. A sandbox app expires on its
// own after about an hour, after which its key fails with "No key found" (40400), so the demo replaces it when that
// happens.
//
// Each app has an `ai` namespace with mutable messages enabled, which the chat channels (`ai:chat-*`) need for appends,
// deletes and annotations. It's set up the way the dashboard sets one up for a new AI Transport app.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PROJECT_DIR } from './config.js';

export const SANDBOX_ENDPOINT = 'nonprod:sandbox';
const SANDBOX_HOST = 'sandbox.realtime.ably-nonprod.net';
const ENV_PATH = `${PROJECT_DIR}/.env`;
/**
 * The errors an expired sandbox app's key fails with: "key/token status changed (expire)" (40132) at first, and "No key
 * found" (40400) once the app has been removed.
 */
const KEY_GONE = new Set([40132, 40400]);

/** Whether the demo runs on a sandbox app: there is no key yet, or the key is a sandbox one. */
export function usesSandbox(): boolean {
  return !process.env.ABLY_KEY || process.env.ABLY_ENDPOINT === SANDBOX_ENDPOINT;
}

/**
 * Creates a sandbox app, and writes its key and the sandbox endpoint to .env and to this process's environment, which
 * worker processes started from now on inherit. The other lines in .env are kept. Returns the app's ID.
 */
export async function createSandboxApp(): Promise<string> {
  const response = await fetch(`https://${SANDBOX_HOST}/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: [{}], namespaces: [{ id: 'ai', persisted: true, mutableMessages: true }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Sandbox app creation failed (${response.status}): ${await response.text()}`);
  }
  const app = (await response.json()) as { appId: string; keys: { keyStr: string }[] };
  const key = app.keys[0].keyStr;

  const kept = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf8')
        .split('\n')
        .filter((line) => line && !/^(ABLY_KEY|ABLY_ENDPOINT)=/.test(line))
    : [];
  writeFileSync(ENV_PATH, [...kept, `ABLY_KEY=${key}`, `ABLY_ENDPOINT=${SANDBOX_ENDPOINT}`, ''].join('\n'));
  process.env.ABLY_KEY = key;
  process.env.ABLY_ENDPOINT = SANDBOX_ENDPOINT;
  return app.appId;
}

/**
 * Whether the sandbox still accepts the key. Only an answer that the key has expired or gone counts: if the sandbox
 * can't be reached, the key is assumed to still work, so that a network blip doesn't replace a working app.
 */
async function sandboxKeyExists(key: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${SANDBOX_HOST}/channels/key-check/messages?limit=1`, {
      headers: { Authorization: `Basic ${Buffer.from(key).toString('base64')}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return true;
    const body = (await response.json().catch(() => undefined)) as { error?: { code?: number } } | undefined;
    return !KEY_GONE.has(body?.error?.code ?? 0);
  } catch {
    return true;
  }
}

/**
 * Makes sure the demo has a working sandbox app, creating one if there is no key or the sandbox app has expired.
 * Does nothing for a key that isn't a sandbox one. Returns the new app's ID if it created one.
 */
export async function ensureSandboxApp(): Promise<string | undefined> {
  if (!usesSandbox()) return undefined;
  const key = process.env.ABLY_KEY;
  if (key && (await sandboxKeyExists(key))) return undefined;
  return createSandboxApp();
}
