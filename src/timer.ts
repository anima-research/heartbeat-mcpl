/** The longest wait setTimeout holds: 2^31-1 ms, about 24.8 days. Asked for
 *  longer, Node warns (TimeoutOverflowWarning) and waits 1 ms instead. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Asked for a negative wait, Node 24 warns (TimeoutNegativeWarning), and Node waits 1 ms
 *  as it does for 0, so no wait here is negative. */
export function callAt(dueAt: number, onDue: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    timer = setTimeout(() => (Date.now() < dueAt ? arm() : onDue()), Math.max(0, Math.min(dueAt - Date.now(), MAX_TIMEOUT_MS)));
  };
  arm();
  return () => clearTimeout(timer);
}
