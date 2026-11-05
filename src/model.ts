// The agent's model call. It runs through the Vercel AI SDK with the Anthropic provider, and returns the reply as the
// AI SDK's UI message chunks, which AI Transport's Vercel adaptor publishes as they are.

import { createAnthropic } from '@ai-sdk/anthropic';
import { convertToModelMessages, streamText, type UIMessage, type UIMessageChunk } from 'ai';
import { config } from './config.js';

// Long enough (a few hundred tokens) that there is time to kill the streaming worker mid-reply.
const SYSTEM_PROMPT = `You are a friendly trip-planning agent in a chat app.
Answer with a practical, specific plan in plain text: a short opening line, then a day-by-day or step-by-step plan
of about 250 to 350 words, with concrete places, times and tips. Use short paragraphs and simple "-" bullet lists.
Do not use Markdown headings, tables or bold text.`;

const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });

/**
 * Starts the model on the conversation so far, and returns its reply as UI message chunks.
 *
 * @param messages - The conversation, oldest first, ending with the user's latest message.
 * @param replyId - The reply's UI message ID. Every attempt at the reply uses the same one, so they describe the
 *   same message.
 * @param signal - Aborts the model call, for example when Temporal cancels the activity.
 */
export async function streamModelReply(
  messages: UIMessage[],
  replyId: string,
  signal: AbortSignal,
): Promise<ReadableStream<UIMessageChunk>> {
  const result = streamText({
    model: anthropic(config.model),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    abortSignal: signal,
  });
  // `generateMessageId` only applies when `originalMessages` is passed too.
  return result
    .toUIMessageStream({ originalMessages: messages, generateMessageId: () => replyId })
    .pipeThrough(failOnErrorChunk());
}

/**
 * `toUIMessageStream` turns a model failure into an `error` chunk and ends the stream normally. Throw instead, so the
 * activity fails and Temporal retries it, rather than publishing the error as the reply.
 */
function failOnErrorChunk(): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === 'error') {
        throw new Error(`The model failed: ${chunk.errorText}`);
      }
      controller.enqueue(chunk);
    },
  });
}
