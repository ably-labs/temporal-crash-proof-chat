// What the turn publishes on the conversation's channel besides the reply itself, shared by the workflow, the browser
// and the verify script. No runtime dependencies, so workflow code and browser code can both import it.

/** The agent's `clientId` on the channel. */
export const AGENT_CLIENT_ID = 'agent';
/** The name of the status messages the turn publishes. */
export const STATUS_MESSAGE = 'agent.status';
/** The annotation type the turn adds to a reply that took more than one attempt. */
export const RETRIED_ANNOTATION = 'retried:flag.v1';

export type TurnState = 'thinking' | 'complete' | 'failed' | 'user-offline';

/** The `data` of an `agent.status` message. */
export interface TurnStatus {
  replyId: string;
  state: TurnState;
  /** For `complete`: the number of attempts the reply took. */
  attempts?: number;
}

/** The `data` of the "retried" annotation. */
export interface RetriedAnnotation {
  attempts: number;
  worker: string;
}
