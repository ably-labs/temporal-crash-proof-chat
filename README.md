# Crash-proof chat

A chat agent that runs as a [Temporal](https://temporal.io) workflow and streams its reply to the browser over Ably. Kill the worker that's streaming the reply, and the reply carries on from the other worker. The user sees one reply bubble that clears and refills, with no duplicated text and no repeated status messages.

It shows three Ably libraries working together:

- **[AI Transport](https://github.com/ably/ably-ai-transport-js)'s Vercel adaptor and decoder** ([#366](https://github.com/ably/ably-ai-transport-js/pull/366)). The worker pipes the AI SDK's UI message stream through `vercelAdaptor`, and the browser decodes it with `vercelDecoder` and folds it with the AI SDK's `readUIMessageStream`. The browser sends the user's message the same way.
- **The realtime channel pool** ([ably-pubsub-js#2340](https://github.com/ably/ably-pubsub-js/pull/2340)). Each worker opens one pool of a few realtime connections when it starts and injects it into its activities. The streaming activity publishes through a pool handle, which satisfies AI Transport's `ChannelWriter` as it is.
- **The Temporal plugin** ([ably-pubsub-js#2325](https://github.com/ably/ably-pubsub-js/pull/2325)). The workflow's discrete Ably calls go through `TemporalAblyHttpClient`: the presence check, the `agent.status` messages and the "retried" annotation. Each runs as an `ably.*` activity, recorded in the workflow history and retried with an idempotency key.

## How a turn works

```
browser ── vercelAdaptor.send(user-message) ──▶ Ably channel mutable:chat-<id>
browser ── POST /api/turns ──▶ server ──▶ Temporal: start chatTurn

chatTurn (workflow, on either worker)
  1. ably.channel.presence.get      is the user still here?  (no: publish user-offline, stop)
  2. ably.channel.publish           agent.status: thinking
  3. streamReply (activity)         model → toUIMessageStream → vercelAdaptor(pool.get(channel)).pipeEach
                                    headers { replyId, attempt, worker }, heartbeat after each event
  4. ably.channel.annotations.publish   "retried" on the reply, if it took more than one attempt
  5. ably.channel.publish           agent.status: complete  (or failed, if every attempt failed)
```

When the worker running `streamReply` dies, its heartbeats stop, and after the 5 second heartbeat timeout Temporal retries the activity on the other worker. The model won't regenerate the same text, so the retry doesn't continue the dead attempt's messages:

1. It reads the serials of the messages the dead attempt published from that attempt's last heartbeat, and deletes them.
2. It streams the reply again as new messages, with `attempt: 2` in their headers.
3. The browser sees the higher attempt, drops what it had folded, clears the bubble and refills it.

The workflow's status publishes don't repeat, because each was recorded in the workflow history before the worker died. A plugin call that's retried carries the same message ID, so Ably discards the copy.

## Setup

You need Node.js 22 or later, pnpm (to build AI Transport), the [Temporal CLI](https://docs.temporal.io/cli) and an Anthropic API key.

```sh
npm run vendor          # clones, merges and builds the unreleased Ably libraries into vendor/ (a few minutes)
npm install
npm run setup:sandbox   # creates an Ably sandbox app and writes ABLY_KEY and ABLY_ENDPOINT to .env
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
```

To use your own Ably app instead of a sandbox one, copy `.env.example` to `.env` and set `ABLY_KEY`. Its `mutable` namespace needs mutable messages enabled, for appends, deletes and annotations. `.env.example` lists the other settings, such as `MODEL` (default `claude-sonnet-5-5`) and `POOL_SIZE` (default 3).

`npm run vendor` builds the SDK from `main` merged with the channel pool branch, and AI Transport from `main`, each pinned to the commit the demo was checked against. See the top of `scripts/vendor.mjs` to build other commits.

## Running it

```sh
temporal server start-dev   # in another terminal, if it isn't running; its UI is on http://localhost:8233
npm start                   # forks workers A and B, and serves the UI on http://localhost:4300
```

## What to look at

1. Send the suggested message. The reply streams into one bubble, and the worker that's streaming it gets a "Streaming here" badge, with a ring on the pool connection carrying it.
2. While it streams, press **Kill worker** on that worker. Its card turns red and its pool goes dark. The bubble stops.
3. About 5 seconds later the bubble clears and refills from the other worker, with a caption naming both workers.
4. **What Temporal recorded** shows `streamReply` attempt 1 failing with a heartbeat timeout on the killed worker, and attempt 2 running on the other one. The turn's ID links to the run in the Temporal UI.
5. **What Ably sees** shows attempt 1's messages greyed out, the retry's deletes highlighted, and still one `thinking` and one `complete` status.
6. Press **Restart worker** to bring the killed worker back.

The **Failure injection** row applies to the workflow's plugin calls rather than the stream. With **Lose the first REST response** on, the first attempt at each status publish and the annotation reaches Ably, then fails as if its response was lost, so Temporal retries it. With idempotent publishing on, Ably discards the retry, so each status still arrives once. Turn off **Idempotent publishing** as well, and the statuses arrive twice.

## Checking it without a browser

With the demo running:

```sh
npm run verify                                            # the crash case
npm run verify -- --no-kill                               # a turn with no failure
npm run verify -- --lose-first-response                   # each status still arrives once
npm run verify -- --lose-first-response --no-idempotency  # each status arrives twice
```

The crash case starts a turn, kills the worker running the stream once 15 text deltas have arrived, and checks the following:

- Ably didn't drop messages on the way to the check (no continuity loss on the channel)
- the reply decoded from the last attempt matches the activity's text
- the killed attempt's heartbeated messages read back as deleted
- `thinking` and `complete` each arrive once
- the reply has the "retried" annotation

The model's text differs between runs, so it checks structure and equality, not content.

## Code

| Path | What it is |
| --- | --- |
| `src/workflows.ts` | The `chatTurn` workflow. It imports nothing from AI Transport or the AI SDK at runtime. |
| `src/activities.ts` | `streamReply`, which pipes the model through `vercelAdaptor` on a pool handle, and deletes a failed attempt's messages. |
| `src/model.ts` | The model call, through the AI SDK's Anthropic provider. |
| `src/worker.ts` | One worker process: the channel pool, `AblyHttpPlugin` and the activities. |
| `src/supervisor.ts`, `src/main.ts` | Forks workers A and B, and kills or restarts one on request. |
| `src/server.ts` | The web server: tokens, turns, a turn's activity attempts, and the workers. |
| `src/failure-injection.ts` | The "lose the first REST response" interceptor. |
| `web/` | The browser app. |
| `scripts/vendor.mjs`, `scripts/verify.ts` | Vendoring, and the headless check. |

## Known gaps

- **A message published after the last heartbeat isn't deleted.** Temporal throttles heartbeats (the worker sets the throttle to 500 ms), so a killed attempt's newest message may be missing from its last heartbeat. That message stays in the channel's history. The browser still ignores it by its `attempt` header, and `npm run verify` reports how many there were.
- **AI Transport's decoder decodes annotation summaries as content.** When the workflow annotates a retried reply, Ably delivers a `message.summary` carrying the whole message, and `vercelDecoder` hands it on as a text delta holding the whole text again (its core passes any action it doesn't know through). The demo ignores `message.summary` deliveries. This should be fixed in AI Transport.
- **The retry pattern is demo code.** The attempt headers, deleting the earlier attempt and replacing the bubble aren't part of AI Transport. The AI Transport team should check that this matches where supersedence is heading (AITRFC-029).
- **No history on reload.** A reload starts a new conversation on a new channel. Rewinding or reading history isn't implemented.
- **One conversation per page**, and one turn at a time.
- **The libraries are unreleased.** `npm run vendor` builds them from pinned commits. Once they're released, the `vendor/` tarballs can be replaced by registry versions.
