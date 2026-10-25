import { RpcError, method } from '@animalabs/mcpl-core';
import type { McplConnection, PushEventParams } from '@animalabs/mcpl-core';

export const PUSH_ANSWER_TIMEOUT_MS = 30_000;

export type PushOutcome =
  | { refusal: string | null; result: unknown }
  | { refusal: string; error: Error };

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
