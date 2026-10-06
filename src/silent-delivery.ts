/**
 * Silent heartbeat delivery, with a fallback to ordinary message mode.
 *
 * Silent mode sends the host's silent-heartbeat marker: an empty push/event on
 * the `heartbeat` feature set with `origin: { source: 'heartbeat', silent: true }`.
 * A host honors it only when it implements silent wakes and this server is
 * configured under the exact id `heartbeat`. Anything else turns the marker
 * into an ordinary empty push. Hosts that reject empty pushes answer it with
 * JSON-RPC invalid params (-32602). For that tick, the heartbeat is sent again
 * in message mode, so the agent still wakes to a prompt it can read.
 *
 * No host advertises silent-wake support during initialize, so the rejection
 * is the only signal. A host that predates both silent wakes and empty-push
 * rejection accepts the empty push and gives the agent a wake with nothing in
 * it. That case cannot be detected from here; the README lists the
 * requirements.
 */
import type { PushEventParams } from '@animalabs/mcpl-core';

/** JSON-RPC invalid params: how a host refuses an empty push. */
export const INVALID_PARAMS = -32602;

/**
 * Did the host refuse a silent push because its content is empty? True for a
 * -32602 error (the marker's empty content is its only invalid param) and for
 * a legacy `{ accepted: false }` result whose reason names empty content.
 */
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

/**
 * Send `silent`; if the host refuses it as empty, send `fallback()` instead
 * (a fresh event, so its eventId is never one the host has already seen).
 * Any other failure, and any failure of the fallback, is thrown to the caller.
 */
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
