import type { PushEventParams } from '@animalabs/mcpl-core';

export const INVALID_PARAMS = -32602;

/** agent-framework refuses an empty push with JSON-RPC -32602, or, where it can't answer with an
 *  error, with accepted: false and the reason empty-content. */
export function isEmptyPushRejection(outcome: { error: unknown } | { result: unknown }): boolean {
  if ('error' in outcome) {
    return (outcome.error as { code?: unknown } | null)?.code === INVALID_PARAMS;
  }
  const r = outcome.result as { accepted?: unknown; reason?: unknown } | null;
  return r?.accepted === false && typeof r.reason === 'string' && /empty/i.test(r.reason);
}

export type SilentDeliveryOutcome =
  | { delivered: 'silent'; result: unknown }
  | { delivered: 'message'; result: unknown; rejection: string };

/** The fallback is a fresh event with its own eventId, since a host SHOULD deduplicate
 *  events by eventId (SPEC §9.4). */
export async function sendSilentWithFallback(
  send: (params: PushEventParams) => Promise<unknown>,
  silent: PushEventParams,
  fallback: () => PushEventParams,
): Promise<SilentDeliveryOutcome> {
  let rejection: string;
  try {
    const result = await send(silent);
    if (!isEmptyPushRejection({ result })) return { delivered: 'silent', result };
    rejection = `accepted:false (${String((result as { reason?: unknown }).reason)})`;
  } catch (error) {
    if (!isEmptyPushRejection({ error })) throw error;
    rejection = (error as Error).message;
  }
  return { delivered: 'message', result: await send(fallback()), rejection };
}
