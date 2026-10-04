import { setTimeout as delay } from "node:timers/promises";

/** Wait for dynamically registered resources without retaining timers after cancellation. */
export async function waitFor(
  ready: () => boolean,
  options: { signal?: AbortSignal; timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const { signal, timeoutMs, intervalMs = 20 } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Invalid readiness wait deadline or interval");
  }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (ready()) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(intervalMs, remaining), undefined, { signal });
  }
}
