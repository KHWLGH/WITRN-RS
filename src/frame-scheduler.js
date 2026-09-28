// @ts-check

/**
 * Coalesce keyed display jobs into one animation frame. Lower priorities run first,
 * so range/card state can be resolved before charts read the current X window.
 * Acquisition and acknowledgment never use this scheduler.
 * @param {{request?: typeof requestAnimationFrame, cancel?: typeof cancelAnimationFrame, report?: (error: unknown) => void}} [options]
 */
export function createFrameScheduler(options = {}) {
  const request = options.request ?? ((callback) => requestAnimationFrame(callback));
  const cancel = options.cancel ?? ((id) => cancelAnimationFrame(id));
  const report = options.report ?? ((error) => console.error('Display refresh failed', error));
  /** @type {Map<string, {callback: () => void, priority: number}>} */
  const jobs = new Map();
  /** @type {number|null} */
  let frame = null;
  let requested = false;
  let flushing = false;

  function flush() {
    frame = null;
    requested = false;
    flushing = true;
    const pending = [...jobs.entries()].sort((a, b) => a[1].priority - b[1].priority);
    // Keep jobs in the map until they run: an earlier job can cancel or update a later job.
    try {
      for (const [key] of pending) {
        const job = jobs.get(key);
        if (!job) continue;
        jobs.delete(key);
        try {
          job.callback();
        } catch (error) {
          report(error);
        }
      }
    } finally {
      flushing = false;
      requestFrame();
    }
  }

  function requestFrame() {
    if (jobs.size > 0 && !requested && !flushing) {
      requested = true;
      const id = request(flush);
      // Tests can execute rAF synchronously; do not retain an already completed request.
      if (requested) frame = id;
    }
  }

  /** @param {string} key @param {() => void} callback @param {number} [priority] */
  function schedule(key, callback, priority = 0) {
    jobs.set(key, { callback, priority });
    requestFrame();
  }

  /** @param {string} key */
  function cancelJob(key) {
    jobs.delete(key);
    if (jobs.size === 0 && requested) {
      if (frame !== null) cancel(frame);
      frame = null;
      requested = false;
    }
  }

  return { schedule, cancel: cancelJob };
}

export const displayFrames = createFrameScheduler();
