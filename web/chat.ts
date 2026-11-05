// The agent chat card. The user's message is published with AI Transport's Vercel adaptor, and the reply is decoded
// with its Vercel decoder and folded into a message with the AI SDK's own reducer, `readUIMessageStream`.
//
// Each attempt at a reply streams as new messages, with an `attempt` header. When a higher attempt starts, the card
// drops the reply it was building, clears the bubble, and folds the new attempt into the same bubble. Late messages
// from an earlier attempt, and the earlier attempt's messages that the retry left undeleted, are ignored by their
// header.

import { vercelAdaptor } from '@ably/ai-transport/vercel';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { STATUS_MESSAGE, type TurnStatus } from '../src/protocol.js';
import { badge, byId, el, postJson } from './dom.js';
import { isSummary, replyHeadersOf, type ReplyDelivery, type Session } from './session.js';

/** A turn the chat has started. */
export interface Turn {
  workflowId: string;
  replyId: string;
  temporalUrl: string;
}

/** What the chat tells the other panels. */
export interface ChatEvents {
  onTurnStarted(turn: Turn): void;
}

interface ReplyView {
  replyId: string;
  root: HTMLElement;
  bubble: HTMLElement;
  badges: HTMLElement;
  caption: HTMLElement;
  /** The attempt being shown, 0 before the first one starts. */
  attempt: number;
  worker?: string;
  /** The stream feeding the AI SDK's reducer for the attempt being shown. */
  stream?: ReadableStreamDefaultController<UIMessageChunk>;
  /** The reply as the reducer last built it. */
  message?: UIMessage;
  /** Settles once the reducer has folded the last chunk of the attempt being shown. */
  folded?: Promise<void>;
  /** The user's message this reply answers. */
  prompt?: UIMessage;
  done: boolean;
}

const textOf = (message: UIMessage) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

/**
 * Calls `enqueue` or `close` on a reply's stream. The reducer cancels the stream when a chunk does not fit what it has
 * seen, after which the controller throws on every call. The reducer's `onError` has logged why, so the call is dropped.
 */
function callStream(call: () => void) {
  try {
    call();
  } catch {
    // The reducer cancelled this stream.
  }
}

export function createChat(session: Session, events: ChatEvents) {
  const { channel, channelName, clientId, decoder } = session;
  const adaptor = vercelAdaptor(channel);
  const messagesEl = byId('messages');
  const form = byId<HTMLFormElement>('composer');
  const input = byId<HTMLInputElement>('prompt');
  const send = byId<HTMLButtonElement>('send');

  byId('chat-channel').textContent = `${channelName} · AI Transport`;

  /** The conversation so far, which each turn is given. */
  const history: UIMessage[] = [];
  const shownUserMessages = new Set<string>();
  const replies = new Map<string, ReplyView>();

  function scrollToEnd() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function append(node: HTMLElement) {
    byId('empty-state').hidden = true;
    messagesEl.append(node);
    scrollToEnd();
  }

  function showUserMessage(message: UIMessage) {
    if (shownUserMessages.has(message.id)) return;
    shownUserMessages.add(message.id);
    append(el('div', { class: 'user-bubble', text: textOf(message) }));
  }

  function replyView(replyId: string): ReplyView {
    let view = replies.get(replyId);
    if (!view) {
      const badges = el('div', { class: 'reply-meta' }, el('span', { class: 'reply-author', text: 'Agent' }));
      const bubble = el('div', { class: 'reply-bubble' });
      const caption = el('p', { class: 'reply-caption', attrs: { hidden: '' } });
      const root = el('div', { class: 'reply' }, badges, bubble, caption);
      view = { replyId, root, bubble, badges, caption, attempt: 0, done: false };
      replies.set(replyId, view);
      append(root);
      setBadges(view, 'Thinking', 'grey');
    }
    return view;
  }

  function setBadges(view: ReplyView, state: string, tone: string) {
    const [author] = view.badges.children;
    view.badges.replaceChildren(author, badge(state, tone, state === 'Streaming'));
    if (view.attempt > 0) {
      view.badges.append(
        badge(`Attempt ${view.attempt} · worker ${view.worker}`, view.attempt > 1 ? 'yellow' : 'outline'),
      );
    }
  }

  function setCaption(view: ReplyView, text: string, error = false) {
    view.caption.textContent = text;
    view.caption.classList.toggle('error', error);
    view.caption.hidden = false;
  }

  /** Starts showing an attempt: a new stream into the reducer, whose output fills the bubble. */
  function startAttempt(view: ReplyView, attempt: number, worker: string) {
    const previous = view.attempt > 0 ? { attempt: view.attempt, worker: view.worker } : undefined;
    if (view.stream) {
      const stale = view.stream;
      callStream(() => stale.close());
    }
    view.attempt = attempt;
    view.worker = worker;
    view.message = undefined;
    view.bubble.textContent = '';
    view.root.classList.add('streaming');
    setBadges(view, 'Streaming', 'violet');
    if (previous) {
      view.root.classList.remove('cleared');
      void view.root.offsetWidth; // Restart the highlight animation.
      view.root.classList.add('cleared');
      setCaption(
        view,
        `Worker ${previous.worker} stopped mid-reply on attempt ${previous.attempt}. Temporal retried on worker ${worker}, and attempt ${attempt} replaced this reply.`,
      );
    }

    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        view.stream = controller;
      },
    });
    view.folded = (async () => {
      const states = readUIMessageStream({ stream, onError: (error) => console.error('[reply]', error) });
      for await (const message of states) {
        if (view.attempt !== attempt) return; // A later attempt replaced this one.
        view.message = message;
        view.bubble.textContent = textOf(message);
        scrollToEnd();
      }
    })();
  }

  decoder.onEvent(({ event, message }: ReplyDelivery) => {
    if (!event || isSummary(message)) return;
    if (event.type === 'user-message') {
      showUserMessage(event.message as UIMessage);
      return;
    }
    const headers = replyHeadersOf(message);
    if (!headers) return;
    const view = replyView(headers.replyId);
    if (view.done || headers.attempt < view.attempt) return;
    if (headers.attempt > view.attempt) startAttempt(view, headers.attempt, headers.worker);

    const stream = view.stream!;
    callStream(() => stream.enqueue(event as UIMessageChunk));
    if (event.type === 'finish') callStream(() => stream.close());
  });

  void channel.subscribe(STATUS_MESSAGE, (message) => {
    const status = message.data as TurnStatus;
    const view = replyView(status.replyId);
    // A status can arrive twice, when the failure injection loses a response and idempotent publishing is off.
    if (view.done) return;
    switch (status.state) {
      case 'thinking':
        if (view.attempt === 0) setBadges(view, 'Thinking', 'grey');
        break;
      case 'complete':
        finish(view);
        setBadges(view, 'Complete', 'green');
        // Finishing closed the reducer's stream. Take the reply once the reducer has folded what was still queued.
        void view.folded?.then(() => {
          if (view.message) history.push(view.message);
        });
        break;
      case 'failed':
        finish(view);
        dropPrompt(view);
        setBadges(view, 'Failed', 'orange');
        setCaption(view, 'Every attempt at this reply failed. See the Temporal panel for why.', true);
        break;
      case 'user-offline':
        finish(view);
        dropPrompt(view);
        setBadges(view, 'Skipped', 'grey');
        setCaption(view, 'The agent found you offline, so it skipped the model.', true);
        break;
    }
  });

  /** Takes an unanswered message out of the conversation, so the next turn does not send two user messages in a row. */
  function dropPrompt(view: ReplyView) {
    const index = view.prompt ? history.indexOf(view.prompt) : -1;
    if (index >= 0) history.splice(index, 1);
  }

  function finish(view: ReplyView) {
    view.done = true;
    view.root.classList.remove('streaming');
    view.root.classList.add('done');
    if (view.stream) {
      const stream = view.stream;
      callStream(() => stream.close());
    }
    setLocked(false);
  }

  function setLocked(locked: boolean) {
    input.disabled = locked;
    send.disabled = locked;
    if (!locked) input.focus();
  }

  form.addEventListener('submit', (submit) => {
    submit.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    void sendMessage(text);
  });

  async function sendMessage(text: string) {
    setLocked(true);
    const userMessage: UIMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
    showUserMessage(userMessage);
    input.value = '';
    const replyId = crypto.randomUUID();
    const view = replyView(replyId);
    try {
      await adaptor.send({ type: 'user-message', message: userMessage });
      history.push(userMessage);
      view.prompt = userMessage;
      const turn = await postJson<Turn>('/api/turns', { channel: channelName, clientId, messages: history, replyId });
      events.onTurnStarted(turn);
    } catch (err) {
      console.error(err);
      finish(view);
      dropPrompt(view);
      setBadges(view, 'Not sent', 'orange');
      setCaption(view, `Could not start the turn: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
}
