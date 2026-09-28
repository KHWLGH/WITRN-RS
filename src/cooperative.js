// @ts-check

/** Yield to input/rendering, without relying on an idle callback that may starve. */
export function yieldToMainThread() {
  const scheduler = /** @type {any} */ (globalThis).scheduler;
  // A fresh background task also lets ordinary timers/IPC callbacks progress.
  // scheduler.yield() gives continuations a priority boost and can starve those
  // tasks across a whole history build even though no individual task is long.
  return scheduler?.postTask
    ? scheduler.postTask(() => {}, { priority: 'background' })
    : new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A step performs a bounded amount of work; time budgets are checked between steps.
 * @param {() => boolean} step Returns true when complete.
 * @param {{isCancelled?: () => boolean, sliceMs?: number, now?: () => number,
 *   yieldTask?: () => Promise<unknown>}} [options]
 * @returns {Promise<boolean>} False means cancelled, never partially published.
 */
export async function runCooperativeSlices(
  step,
  { isCancelled = () => false, sliceMs = 1.5, now = () => performance.now(), yieldTask = yieldToMainThread } = {},
) {
  // Never start an expensive first slice inside the input handler that requested it.
  await yieldTask();
  while (!isCancelled()) {
    const deadline = now() + sliceMs;
    do {
      if (step()) return !isCancelled();
    } while (!isCancelled() && now() < deadline);
    if (!isCancelled()) await yieldTask();
  }
  return false;
}
