/**
 * Sending a push/event and reading what came of it.
 *
 * A reminder waits on its push's answer (see fireReminder and settleReminder
 * in index.ts), so the answer has to come or the push has to fail: a push the
 * host never answers fails after PUSH_ANSWER_TIMEOUT_MS. The bound is given
 * here rather than left to mcpl-core's default, because what happens to a
 * reminder depends on it.
 */
import { RpcError, method } from '@animalabs/mcpl-core';
import type { McplConnection, PushEventParams } from '@animalabs/mcpl-core';

/** How long the host has to answer a push/event before it counts as failed. */
export const PUSH_ANSWER_TIMEOUT_MS = 30_000;

/** What came of a push/event. `refusal` is null when the host took it, and
 *  otherwise says, in words for the agent, why it didn't arrive. `result` is
 *  the host's answer and `error` the failure, whichever there was. */
export type PushOutcome =
  | { refusal: string | null; result: unknown }
  | { refusal: string; error: Error };

/** Send a push/event. Never rejects: a refusal, an error answer, no answer in
 *  time and a closed connection all come back as a refusal. Only an answer
 *  that says `accepted: false` is a refusal by the host; any other answer
 *  means it took the push. */
export async function sendPush(conn: McplConnection, params: PushEventParams): Promise<PushOutcome> {
  let result: unknown;
  try {
    result = await conn.sendRequest(method.PUSH_EVENT, params, PUSH_ANSWER_TIMEOUT_MS);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // mcpl-core 0.2 starts an RpcError's message with "RPC error <code>: ", for an error
    // answer and its own timeout alike, and the agent is told the rest.
    const why = error instanceof RpcError ? error.message.replace(`RPC error ${error.code}: `, '') : error.message;
    return { refusal: `the push failed: ${why}`, error };
  }
  const answer = result as { accepted?: unknown; reason?: unknown } | null;
  if (answer?.accepted !== false) return { refusal: null, result };
  const reason = typeof answer.reason === 'string' && answer.reason ? `: ${answer.reason}` : '';
  return { refusal: `the host refused it${reason}`, result };
}
