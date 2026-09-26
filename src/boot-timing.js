// Reports the webview half of cold start to Rust, which owns the process-start half.
//
// The bridge is `performance.timeOrigin`: it is epoch-based, so subtracting the Rust-side
// process-start epoch gives the cargo→embed→webview-create→navigation span that no page-side
// timestamp can observe. Everything here is measured relative to the page's own origin.
//
// Deliberately a classic script rather than a module: it must register before any module graph
// has had a chance to delay, and it takes on no app dependencies.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return;
  const marks = {};
  let sent = false;

  // Document requests are the thing a CSS/HTML merge would remove, so measure them rather than
  // argue about them: count, and the span they actually occupy.
  const resourceSummary = () => {
    /** @type {PerformanceResourceTiming[]} */
    const entries = /** @type {PerformanceResourceTiming[]} */ (
      /** @type {unknown} */ (performance.getEntriesByType('resource'))
    );
    if (!entries.length) return null;
    const first = Math.min(...entries.map((e) => e.startTime));
    const last = Math.max(...entries.map((e) => e.responseEnd || e.startTime));
    // Split by host, because the raw total is not a frontend-shape measurement: Tauri's IPC calls
    // (http://ipc.localhost) land in the same list, so the count drifts with how much async work
    // finished since page-visibility changed. Measured: an unmerged-stylesheets build reported 72 and
    // the merged build 79-81 -- the opposite of the intended direction -- until the two were separated.
    /** @type {Record<string, number>} */
    const byHost = {};
    for (const entry of entries) {
      let host = 'other';
      try {
        host = new URL(entry.name).host || 'other';
      } catch {}
      byHost[host] = (byHost[host] ?? 0) + 1;
    }
    return { count: entries.length, firstStartMs: first, lastEndMs: last, totalMs: last - first, byHost };
  };

  const paintStart = (name) =>
    performance.getEntriesByType('paint').find((entry) => entry.name === name)?.startTime ?? null;

  const flush = () => {
    sent = true;
    invoke('report_boot_timing', {
      timing: {
        timeOriginMs: performance.timeOrigin,
        firstPaintMs: paintStart('first-paint'),
        firstContentfulPaintMs: paintStart('first-contentful-paint'),
        marks,
        resources: resourceSummary(),
        userAgent: navigator.userAgent,
      },
    }).catch(() => {
      /* timing must never break the app */
    });
  };

  // Marks added after the first send re-report, so late stages (first data draw) still arrive.
  window.__WITRN_BOOT__ = {
    mark(name) {
      marks[name] = performance.now();
      if (sent) flush();
    },
  };

  // The first flush fires on the rAF after DOMContentLoaded, which is not reliably after the paint
  // entries exist: measured, only 1 of 5 launches had `first-paint` in the report it sent. Without
  // this observer the tool reads whichever write happened to land first, so the published firstPaint
  // row was the lucky subset rather than a p50. `buffered: true` also catches paints that already
  // happened before this line ran.
  if (typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name !== 'first-paint' && entry.name !== 'first-contentful-paint') continue;
          if (!sent) continue;
          flush();
        }
      }).observe({ type: 'paint', buffered: true });
    } catch {
      /* paint timing is not the app's problem; the tool reports null instead */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(flush), { once: true });
  } else {
    requestAnimationFrame(flush);
  }

  // `load` is the only point where the initial module graph has definitively finished, so the
  // resource snapshot taken before it is a partial one: measured, the two shapes differed by 8
  // entries in whichever direction the snapshot happened to land. Re-reporting here makes the count
  // comparable across builds instead of comparable across luck.
  window.addEventListener('load', () => flush(), { once: true });
})();
