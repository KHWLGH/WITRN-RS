// @ts-check
/**
 * Bounded, read-only performance telemetry for real-device acceptance runs.
 * The acquisition path only appends small numeric records at batch boundaries;
 * no DOM work, timers, or unbounded history is introduced here.
 */

const RING_SIZE = 512;
const LONG_TASK_LIMIT_MS = 50;

/** @param {number[]} values */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * p)));
  return sorted[index];
}

/** @param {Array<{at:number, [key:string]:any}>} ring @param {{at:number, [key:string]:any}} value */
function pushRing(ring, value) {
  ring.push(value);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

const batches = /** @type {Array<any>} */ ([]);
const charts = /** @type {{main: Array<any>, navigator: Array<any>}} */ ({ main: [], navigator: [] });
const dom = /** @type {Array<any>} */ ([]);
const inputs = /** @type {Array<any>} */ ([]);
const frames = /** @type {Array<any>} */ ([]);
const longTasks = /** @type {Array<any>} */ ([]);
const memorySamples = /** @type {Array<any>} */ ([]);
let latestSampleWallMs = null;
let batchStarted = 0;
let frameLoopStarted = false;
let lastFrameAt = 0;
let lastChartDrawAt = -Infinity;
let idleFrameMs = 1000 / 60;
const idleFrameIntervals = /** @type {number[]} */ ([]);
let pendingInputAt = null;
let pendingInputFrame = 0;
let inputListenerInstalled = false;
let longTaskObserverInstalled = false;
let lastMemorySampleAt = -Infinity;

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** @param {number|undefined|null} wallMs */
function setLatestSampleWallMs(wallMs) {
  if (Number.isFinite(wallMs)) latestSampleWallMs = /** @type {number} */ (wallMs);
}

export function latestSampleWallTime() {
  return latestSampleWallMs;
}

/** @param {number} _size */
export function batchStart(_size) {
  batchStarted = now();
  return batchStarted;
}

/**
 * @param {number} accepted
 * @param {{startedAt?:number, endedAt?:number, durationMs?:number, firstReceivedWallMs?:number|null, lastReceivedWallMs?:number|null, lastSeq?:number|null}} timing
 */
export function batchEnd(accepted, timing = {}) {
  const endedAt = Number.isFinite(timing.endedAt) ? /** @type {number} */ (timing.endedAt) : now();
  const startedAt = Number.isFinite(timing.startedAt)
    ? /** @type {number} */ (timing.startedAt)
    : batchStarted || endedAt;
  const durationMs = Number.isFinite(timing.durationMs)
    ? /** @type {number} */ (timing.durationMs)
    : endedAt - startedAt;
  const lastReceivedWallMs = Number.isFinite(timing.lastReceivedWallMs)
    ? /** @type {number} */ (timing.lastReceivedWallMs)
    : null;
  setLatestSampleWallMs(lastReceivedWallMs);
  pushRing(batches, {
    at: endedAt,
    size: Number.isFinite(accepted) ? accepted : 0,
    startedAt,
    endedAt,
    durationMs,
    firstReceivedWallMs: Number.isFinite(timing.firstReceivedWallMs) ? timing.firstReceivedWallMs : null,
    lastReceivedWallMs,
    lastSeq: Number.isSafeInteger(timing.lastSeq) ? timing.lastSeq : null,
  });
}

/** @param {'main'|'navigator'} role @param {{requestedAt?:number, submittedAt?:number, prepareMs?:number|null, batchId?:number, sourcePointCount?:number, displayPointCount?:number, pixelsPerBucket?:number, displayDense?:boolean, fillSuppressed?:boolean, fillSuppressionReason?:string|null, recentAppendCount?:number, refreshIntervalMs?:number}} info */
export function chartRequest(role, info = {}) {
  return {
    at: Number.isFinite(info.requestedAt) ? /** @type {number} */ (info.requestedAt) : now(),
    requestedAt: Number.isFinite(info.requestedAt) ? /** @type {number} */ (info.requestedAt) : now(),
    submittedAt: Number.isFinite(info.submittedAt) ? /** @type {number} */ (info.submittedAt) : null,
    prepareMs: Number.isFinite(info.prepareMs) ? info.prepareMs : null,
    batchId: Number.isSafeInteger(info.batchId) ? info.batchId : null,
    sampleWallMs: latestSampleWallMs,
    sourcePointCount: info.sourcePointCount ?? null,
    displayPointCount: info.displayPointCount ?? null,
    pixelsPerBucket: info.pixelsPerBucket ?? null,
    displayDense: info.displayDense ?? false,
    fillSuppressed: info.fillSuppressed ?? false,
    fillSuppressionReason: info.fillSuppressionReason ?? null,
    recentAppendCount: info.recentAppendCount ?? 0,
    refreshIntervalMs: info.refreshIntervalMs ?? null,
    role,
  };
}

/** @param {'main'|'navigator'} role @param {any} request @param {number} drawEndedAt @param {number|null} drawMs */
export function chartPaint(role, request, drawEndedAt = now(), drawMs = null) {
  if (!request) return;
  lastChartDrawAt = drawEndedAt;
  const sampleToPaintMs =
    Number.isFinite(request.sampleWallMs) &&
    typeof performance !== 'undefined' &&
    Number.isFinite(performance.timeOrigin)
      ? drawEndedAt + performance.timeOrigin - request.sampleWallMs
      : null;
  const entry = {
    at: drawEndedAt,
    requestedAt: request.requestedAt,
    submittedAt: request.submittedAt,
    drawEndedAt,
    requestToDrawMs: drawEndedAt - request.requestedAt,
    submitToDrawMs: Number.isFinite(request.submittedAt) ? drawEndedAt - request.submittedAt : null,
    prepareMs: request.prepareMs,
    batchId: request.batchId,
    sampleWallMs: request.sampleWallMs,
    sampleToPaintMs,
    sourcePointCount: request.sourcePointCount,
    displayPointCount: request.displayPointCount,
    pixelsPerBucket: request.pixelsPerBucket,
    displayDense: request.displayDense,
    fillSuppressed: request.fillSuppressed,
    fillSuppressionReason: request.fillSuppressionReason,
    recentAppendCount: request.recentAppendCount,
    refreshIntervalMs: request.refreshIntervalMs,
    drawMs,
    nextFrameDelayMs: /** @type {number|null} */ (null),
    frameDelayMs: /** @type {number|null} */ (null),
  };
  pushRing(charts[role], entry);
  return entry;
}

/** @param {any} entry @param {number} delayMs @param {number} frameDelayMs */
export function chartNextFrame(entry, delayMs, frameDelayMs = delayMs) {
  if (entry && Number.isFinite(delayMs)) {
    entry.nextFrameDelayMs = delayMs;
    entry.frameDelayMs = frameDelayMs;
  }
}

/**
 * Raster backlogs may block a later frame even if the first callback is cheap.
 * clipStart excludes work before the actual paint when evaluating fill cost.
 * @param {number} since
 */
export function frameDelaySince(since, inclusive = true, clipStart = false) {
  let delay = 0;
  for (let i = frames.length - 1; i >= 0 && (inclusive ? frames[i].at >= since : frames[i].at > since); i--) {
    const duration = clipStart
      ? Math.min(frames[i].durationMs, Math.max(0, frames[i].at - since))
      : frames[i].durationMs;
    delay = Math.max(delay, duration);
  }
  return delay;
}

export function idleFrameIntervalMs() {
  return idleFrameMs;
}

/** @param {string} name @param {number} startedAt @param {number} [endedAt] */
export function domCommit(name, startedAt, endedAt = now()) {
  const sampleToDomMs =
    Number.isFinite(latestSampleWallMs) && typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
      ? endedAt + performance.timeOrigin - /** @type {number} */ (latestSampleWallMs)
      : null;
  pushRing(dom, {
    at: endedAt,
    name,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    sampleToDomMs,
  });
}

function scheduleInputFlush() {
  if (pendingInputFrame || typeof requestAnimationFrame !== 'function') return;
  pendingInputFrame = requestAnimationFrame(() => {
    pendingInputFrame = 0;
    if (pendingInputAt == null) return;
    const completedAt = now();
    pushRing(inputs, { at: completedAt, durationMs: completedAt - pendingInputAt });
    pendingInputAt = null;
  });
}

function installInputListener() {
  if (inputListenerInstalled || typeof document === 'undefined' || typeof document.addEventListener !== 'function')
    return;
  inputListenerInstalled = true;
  const events = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'click'];
  for (const type of events) {
    document.addEventListener(
      type,
      () => {
        const at = now();
        pendingInputAt = pendingInputAt == null ? at : Math.min(pendingInputAt, at);
        scheduleInputFlush();
      },
      { capture: true, passive: type === 'wheel' },
    );
  }
}

function installLongTaskObserver() {
  if (longTaskObserverInstalled || typeof PerformanceObserver !== 'function') return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_LIMIT_MS) continue;
        pushRing(longTasks, {
          at: entry.startTime + entry.duration,
          name: entry.name,
          start: entry.startTime,
          durationMs: entry.duration,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    longTaskObserverInstalled = true;
  } catch {
    // WebView2 versions without longtask support leave this section empty.
  }
}

function frameTick(at) {
  if (typeof document === 'undefined' || !document.hidden) {
    if (lastFrameAt > 0) {
      const durationMs = at - lastFrameAt;
      pushRing(frames, { at, durationMs });
      // Frames containing a draw can include deferred raster work. Intervening
      // frames measure the display's idle refresh interval instead.
      if (lastChartDrawAt <= lastFrameAt && durationMs >= 4 && durationMs <= 50) {
        idleFrameIntervals.push(durationMs);
        if (idleFrameIntervals.length > 32) idleFrameIntervals.shift();
        // Raster work can back up more than one frame. A low percentile keeps
        // those delayed frames from teaching the controller that lag is normal.
        idleFrameMs = percentile(idleFrameIntervals, 0.2) ?? 1000 / 60;
      }
    }
    lastFrameAt = at;
  } else {
    lastFrameAt = 0;
  }
  sampleMemory(at);
  scheduleInputFlush();
  requestAnimationFrame(frameTick);
}

export function start() {
  installInputListener();
  installLongTaskObserver();
  sampleMemory(now());
  if (frameLoopStarted || typeof requestAnimationFrame !== 'function') return;
  frameLoopStarted = true;
  requestAnimationFrame(frameTick);
}

/** @param {Array<{durationMs:number}>} ring */
function summary(ring) {
  const values = ring.map((entry) => entry.durationMs).filter(Number.isFinite);
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function memorySnapshot() {
  const memory = typeof performance !== 'undefined' ? /** @type {any} */ (performance).memory : null;
  if (!memory) return null;
  return {
    usedJSHeapSize: Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null,
    totalJSHeapSize: Number.isFinite(memory.totalJSHeapSize) ? memory.totalJSHeapSize : null,
    jsHeapSizeLimit: Number.isFinite(memory.jsHeapSizeLimit) ? memory.jsHeapSizeLimit : null,
  };
}

/** @param {number} at */
function sampleMemory(at) {
  if (at - lastMemorySampleAt < 1000) return;
  const memory = memorySnapshot();
  if (!memory) return;
  lastMemorySampleAt = at;
  pushRing(memorySamples, { at, ...memory });
}

export function snapshot() {
  const main = charts.main.at(-1) ?? null;
  const navigator = charts.navigator.at(-1) ?? null;
  const frame = summary(frames);
  const frameValues = frames.map((entry) => entry.durationMs).filter(Number.isFinite);
  const fps = frameValues.length ? 1000 / (frameValues.reduce((a, b) => a + b, 0) / frameValues.length) : null;
  return {
    now: now(),
    timeOrigin:
      typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null,
    latestSampleWallMs,
    batches: { count: batches.length, last: batches.at(-1) ?? null, duration: summary(batches) },
    charts: {
      main: {
        count: charts.main.length,
        last: main,
        nextFrameDelay: summary(
          charts.main
            .filter((x) => Number.isFinite(x.nextFrameDelayMs))
            .map((x) => ({ durationMs: x.nextFrameDelayMs })),
        ),
        frameDelay: summary(
          charts.main.filter((x) => Number.isFinite(x.frameDelayMs)).map((x) => ({ durationMs: x.frameDelayMs })),
        ),
        requestToDraw: summary(charts.main.map((x) => ({ durationMs: x.requestToDrawMs }))),
        sampleToPaint: summary(
          charts.main.filter((x) => Number.isFinite(x.sampleToPaintMs)).map((x) => ({ durationMs: x.sampleToPaintMs })),
        ),
      },
      navigator: {
        count: charts.navigator.length,
        last: navigator,
        requestToDraw: summary(charts.navigator.map((x) => ({ durationMs: x.requestToDrawMs }))),
        sampleToPaint: summary(
          charts.navigator
            .filter((x) => Number.isFinite(x.sampleToPaintMs))
            .map((x) => ({ durationMs: x.sampleToPaintMs })),
        ),
      },
    },
    dom: {
      count: dom.length,
      last: dom.at(-1) ?? null,
      duration: summary(dom),
      sampleToDom: summary(
        dom.filter((x) => Number.isFinite(x.sampleToDomMs)).map((x) => ({ durationMs: x.sampleToDomMs })),
      ),
    },
    frames: { count: frames.length, fps, interval: frame, idleFrameMs },
    inputs: { count: inputs.length, latency: summary(inputs) },
    longTasks: { count: longTasks.length, duration: summary(longTasks), last: longTasks.at(-1) ?? null },
    memory: memorySnapshot(),
    memoryHistory: memorySamples.slice(),
  };
}

/** Clear measured samples without stopping the frame/input observers. */
export function reset() {
  for (const ring of [batches, charts.main, charts.navigator, dom, inputs, frames, longTasks, memorySamples]) {
    ring.length = 0;
  }
  latestSampleWallMs = null;
  batchStarted = 0;
  lastFrameAt = 0;
  lastChartDrawAt = -Infinity;
  idleFrameMs = 1000 / 60;
  idleFrameIntervals.length = 0;
  pendingInputAt = null;
  lastMemorySampleAt = -Infinity;
}

export const performanceDiagnostics = {
  start,
  snapshot,
  reset,
  batchStart,
  batchEnd,
  chartRequest,
  chartPaint,
  chartNextFrame,
  idleFrameIntervalMs,
  frameDelaySince,
  domCommit,
  latestSampleWallTime,
};
