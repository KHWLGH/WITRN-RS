import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceDiagnostics } from '../src/performance-diagnostics.js';

let time = 1000;
let frameId = 0;
const frames = new Map();
const listeners = new Map();
const attrs = new Map();
const mainHost = { clientWidth: 600, clientHeight: 300, setAttribute: (key, value) => attrs.set(key, value) };
globalThis.performance = { now: () => time, timeOrigin: 0 };
globalThis.document = {
  hidden: false,
  documentElement: {},
  addEventListener: (event, callback) => listeners.set(event, callback),
  getElementById: (id) => (id === 'main-chart' ? mainHost : null),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.uPlot = class {
  static paths = { spline: () => () => null, linear: () => () => null };
  constructor(options, data) {
    Object.assign(this, { options, data, width: options.width, height: options.height, hooks: options.hooks });
  }
  setData(data) {
    this.submissions = (this.submissions ?? 0) + 1;
    this.data = data;
    queueMicrotask(() => {
      for (const hook of this.hooks.drawClear ?? []) hook(this);
      time += 0.4;
      for (const hook of this.hooks.draw ?? []) hook(this);
    });
  }
  setScale() {}
  redraw() {}
};

const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
const chart = await import('../src/chart.js');

async function frame(delayMs) {
  time += delayMs;
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(time);
  await Promise.resolve();
}

async function paintFeedback(delayMs = 16, delayed = false) {
  await frame(delayed ? 16 : delayMs);
  if (!delayed && delayMs > 100) return;
  await frame(delayed ? delayMs : 16);
  if (delayed && delayMs > 100) return;
  await frame(16);
}

async function submit() {
  chart.updateCharts('live');
  await Promise.resolve();
}

function seed(recording = true, count = 5000, interval = 1) {
  const cols = emptyChartColumns();
  for (const [key, col] of Object.entries(cols)) {
    const values = new Float64Array(count);
    if (key === 'x') for (let i = 0; i < count; i++) values[i] = (i * interval) / 1000;
    else if (key === 'voltage') for (let i = 0; i < count; i++) values[i] = i % 2;
    else if (key === 'sampleIntervals') values.fill(interval);
    else values.fill(1);
    col.set(values);
  }
  setChartColumns(cols);
  state.settings.activeView = 'monitor';
  state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
  state.isRecording = recording;
  chart.initChart();
  chart.setChartXWindow(0, ((count - 1) * interval) / 1000);
}

test('real draw hooks lower the bound density even when JS drawing is cheap, preserving every raw point', async () => {
  seed();
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40);
  await submit();
  await paintFeedback(40);
  await submit();
  assert.ok(state.mainChart.data[0].length < before);
  assert.equal(state.chartSeries.x.length, 5000);
  assert.equal(Math.max(...state.mainChart.data[1]), 1);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 4);
  assert.equal(last.fillSuppressed, false, 'a first density reduction must retain the user fill');
  assert.equal(last.displayDense, true);
  assert.equal(last.recentAppendCount, 0, 'preloaded history is not a live batch');
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(last.sourcePointCount, 5000);
  assert.equal(last.displayPointCount, state.mainChart.data[0].length);
  assert.ok(last.drawMs < 1);
  assert.equal(last.refreshSource, 'maintenance');
  assert.equal(last.refreshIntervalMs, 0, 'a display-budget repaint is not an acquisition refresh');
  await paintFeedback(40);
  await submit();
  await paintFeedback(40);
  await submit();
  const protectedDraw = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(protectedDraw.fillSuppressed, true);
  assert.equal(protectedDraw.fillSuppressionReason, 'persistent-slow-frame');
  assert.equal(state.mainChart.options.series[1].fill(), null);
});

test('background callbacks and paints from replaced columns never degrade the current recording', async () => {
  await frame(16);
  chart.syncChartSeries();
  await submit();
  const before = state.mainChart.data[0].length;
  document.hidden = true;
  listeners.get('visibilitychange')();
  await frame(200);
  document.hidden = false;
  listeners.get('visibilitychange')();
  await frame(16);
  await submit();
  chart.syncChartSeries();
  await frame(200);
  await submit();
  assert.equal(state.mainChart.data[0].length, before);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 2);
  state.isRecording = false;
  chart.syncChartSeries();
});

test('paused review confirms a slow static draw, then reduces density without incoming samples', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40);
  assert.equal(state.mainChart.submissions, 1, 'first slow feedback schedules, rather than submits, a probe');
  assert.ok(frames.size > 0);
  await frame(16);
  assert.equal(state.mainChart.submissions, 2, 'an unchanged static binding must actually redraw for confirmation');
  await paintFeedback(40);
  await frame(16);
  assert.ok(state.mainChart.data[0].length < before);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 4);
  assert.equal(last.fillSuppressed, false, 'first confirmed slow draw only reduces density');
  assert.equal(last.refreshIntervalMs, 0, 'review interactions are not paced like acquisition');
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  await paintFeedback(40);
  await frame(16);
  await paintFeedback(40);
  await frame(16);
  const protectedDraw = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(protectedDraw.fillSuppressed, true);
  assert.equal(protectedDraw.fillSuppressionReason, 'persistent-slow-frame');
  assert.equal(state.mainChart.options.series[1].fill(), null);
  assert.equal(state.chartSeries.x.length, 5000);
  assert.equal(Math.max(...state.mainChart.data[1]), 1);
  await paintFeedback();
  assert.equal(frames.size, 0, 'healthy feedback ends static repaint work');
});

test('a healthy confirmation stops review probes without reducing detail', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40);
  await frame(16);
  await paintFeedback();
  assert.equal(state.mainChart.submissions, 2);
  assert.equal(state.mainChart.data[0].length, before);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 2);
  assert.equal(frames.size, 0);
});

test('persistently slow static review has a bounded probe chain and stops at the coarsest level', async () => {
  seed(false);
  await submit();
  for (let i = 0; i < 40 && frames.size > 0; i++) await frame(i % 4 === 0 ? 40 : 16);
  assert.equal(frames.size, 0, 'there is no idle redraw loop at the budget limit');
  assert.ok(state.mainChart.submissions <= 7);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 16);
  await frame(120);
  assert.equal(frames.size, 0, 'even severe feedback at the limit cannot schedule another probe');
  assert.equal(state.chartSeries.x.length, 5000);
});

test('one severe review frame immediately coarsens the static projection', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await frame(120);
  await frame(16);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 8);
  assert.equal(last.fillSuppressed, true);
  assert.equal(last.fillSuppressionReason, 'severe-frame');
  assert.ok(state.mainChart.data[0].length < before);
  await paintFeedback();
  assert.equal(frames.size, 0);
});

test('changing a review window retires its queued confirmation and sparse feedback', async () => {
  seed(false);
  await submit();
  await paintFeedback(40);
  chart.setChartXWindow(1.2, 1.21);
  await frame(16);
  assert.equal(state.mainChart.data[0].length, 13);
  await frame(120);
  assert.equal(frames.size, 0);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 2);
  assert.equal(last.fillSuppressed, false);
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  chart.setChartXWindow(2, 4.999);
  await submit();
  await paintFeedback(40);
  assert.equal(
    performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket,
    2,
    'an unrelated window cannot inherit the first slow sample',
  );
  await frame(16);
  await paintFeedback();
});

test('backgrounding and replacing the source retire queued review probes', async () => {
  seed(false);
  await submit();
  await paintFeedback(40);
  document.hidden = true;
  listeners.get('visibilitychange')();
  await frame(200);
  assert.equal(state.mainChart.submissions, 1);
  document.hidden = false;
  listeners.get('visibilitychange')();
  await frame(16);
  await frame(16);
  await submit();
  await paintFeedback(40);
  seed(false);
  await submit();
  await paintFeedback();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 2);
  assert.equal(state.mainChart.submissions, 1);
  assert.equal(frames.size, 0);
});

test('live fill protection catches a severe raster stall after a cheap first callback', async () => {
  seed(true);
  await submit();
  await paintFeedback(120, true);
  await submit();
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.fillSuppressed, true);
  assert.equal(last.fillSuppressionReason, 'severe-frame');
  assert.equal(last.pixelsPerBucket, 8);
  await paintFeedback();
});

test('static review catches delayed raster frames after a cheap first callback', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40, true);
  const first = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(first.nextFrameDelayMs, 16);
  assert.equal(first.frameDelayMs, 40);
  assert.equal(state.mainChart.submissions, 1);
  await frame(16);
  await paintFeedback(40, true);
  await frame(16);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 4);
  assert.ok(state.mainChart.data[0].length < before);
  await paintFeedback();
  assert.equal(frames.size, 0);
});

async function prepared() {
  for (let i = 0; attrs.get('aria-busy') === 'true'; i++) {
    assert.ok(i < 1000, 'cooperative preparation must finish');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await Promise.resolve();
}

function append(count, interval = 1) {
  const cols = state.chartSeries;
  const start = cols.x.length;
  for (let i = start; i < start + count; i++)
    for (const [key, col] of Object.entries(cols))
      col.push(
        key === 'x' ? (i * interval) / 1000 : key === 'sampleIntervals' ? interval : key === 'voltage' ? i % 2 : 1,
      );
  const end = cols.x.at(-1);
  chart.setChartXWindow(state.chartWindow.mode === 'follow' ? end - state.chartWindow.duration : 0, end);
}

test('display-dense windows below four points per pixel retain fill, even after slow frames', async () => {
  for (const recording of [true, false]) {
    for (const count of [601, 1200, 2399]) {
      seed(recording, count);
      await submit();
      await frame(120);
      await frame(16);
      await submit();
      const last = performanceDiagnostics.snapshot().charts.main.last;
      assert.equal(last.displayDense, true);
      assert.equal(last.fillSuppressed, false);
      assert.equal(last.fillSuppressionReason, null);
      assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
    }
  }
});

test('four points per pixel is eligibility, not an automatic fill cutoff', async () => {
  for (const recording of [true, false]) {
    seed(recording, 2400);
    await submit();
    await paintFeedback();
    assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
    assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
  }
});

test('three-hour 100Hz history and healthy small live batches keep fill and exact samples', async () => {
  seed(true, 1_080_000, 10);
  await submit();
  await prepared();
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.recentAppendCount, 0);
  for (let i = 0; i < 20; i++) {
    await paintFeedback();
    append(10, 10);
    await submit();
    assert.equal(performanceDiagnostics.snapshot().charts.main.last.recentAppendCount, 10);
    assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  }
  assert.equal(state.chartSeries.x.length, 1_080_200);
  assert.equal(state.chartSeries.x.valueAt(100_003), 1000.03);
  assert.equal(state.chartSeries.voltage.valueAt(100_003), 1);
});

test('large 1000Hz batches need real pressure; continued pressure after reduction suppresses fill', async () => {
  seed(true);
  await submit();
  await frame(16);
  append(2500);
  await submit();
  let last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.recentAppendCount, 2500);
  assert.equal(last.fillSuppressed, false, 'large appends alone cannot turn fill off');
  for (let i = 0; i < 2; i++) {
    await paintFeedback(40);
    append(2500);
    await submit();
  }
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 4);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
  for (let i = 0; i < 2; i++) {
    await paintFeedback(40);
    append(2500);
    await submit();
  }
  last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.fillSuppressed, true);
  assert.equal(last.fillSuppressionReason, 'large-batch-slow-frame');
  assert.equal(last.recentAppendCount, 2500);
  assert.equal(state.chartSeries.x.length, 17500);
});

test('suppression is retired by sparse windows, user fill zero, hidden pages and source replacement', async () => {
  for (const transition of ['sparse', 'user', 'hidden', 'source']) {
    seed(false);
    await submit();
    await frame(120);
    await frame(16);
    assert.equal(state.mainChart.options.series[1].fill(), null);
    if (transition === 'sparse') chart.setChartXWindow(1, 1.01);
    else if (transition === 'user') {
      for (let i = 0; i < 4; i++) chart.setSeriesFill(i, 0);
    } else if (transition === 'hidden') {
      document.hidden = true;
      listeners.get('visibilitychange')();
      await frame(200);
      document.hidden = false;
      listeners.get('visibilitychange')();
    } else seed(false);
    await submit();
    const last = performanceDiagnostics.snapshot().charts.main.last;
    assert.equal(last.fillSuppressed, false, transition);
    assert.equal(last.fillSuppressionReason, null, transition);
    if (transition === 'user') {
      assert.equal(state.mainChart.options.series[1].fill(), null);
      chart.setSeriesFill(0, 15);
    } else assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  }
});

test('stable live paints restore fill with a real submission, without a tight recovery loop', async () => {
  seed(true);
  await submit();
  await frame(120);
  await submit();
  assert.equal(state.mainChart.options.series[1].fill(), null);
  for (let i = 0; i < 55; i++) {
    await paintFeedback();
    time += 52;
    append(10);
    await submit();
  }
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.fillSuppressed, false);
  assert.equal(last.fillSuppressionReason, null);
  assert.equal(last.recentAppendCount, 10);
});

test('live user zoom cancels fill evidence while natural follow appends retain it', async () => {
  seed(true);
  state.chartWindow = { mode: 'follow', min: 0, max: 4.999, duration: 4.999 };
  await submit();
  await paintFeedback(40);
  append(100);
  await submit();
  await paintFeedback(40);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 4);
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  for (let i = 0; i < 2; i++) {
    await paintFeedback(40);
    append(100);
    await submit();
  }
  assert.equal(state.mainChart.options.series[1].fill(), null);
  state.chartWindow = { mode: 'follow', min: 2, max: 5.299, duration: 3.299 };
  chart.setChartXWindow(2, 5.299);
  await submit();
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
});

test('history preparation before draw does not falsely establish expensive fill', async () => {
  seed(true);
  performanceDiagnostics.reset();
  performanceDiagnostics.start();
  for (let i = 0; i < 32; i++) await frame(8);
  time += 200; // Import/column preparation in the same task, before submitting Canvas work.
  await submit();
  await frame(8);
  await submit();
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.ok(last.pixelsPerBucket > 2, 'projection can react to overall request pressure');
  assert.equal(last.fillSuppressed, false, 'fill must observe its own draw rather than pre-paint work');
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(performanceDiagnostics.frameDelaySince(time - 9, true, true) <= 9, true);
});

test('moving a dense window every frame retains feedback across the same gesture', async () => {
  for (const recording of [true, false]) {
    seed(recording);
    chart.setRangeDragging(true);
    await submit();
    for (let i = 0; i < 8; i++) {
      chart.setChartXWindow(0.1 + i * 0.01, 4.8 + i * 0.01);
      chart.scheduleChartUpdate('interaction');
      await frame(i < 2 ? 40 : 16);
    }
    chart.setRangeDragging(false);
    chart.updateCharts('interaction');
    await Promise.resolve();
    const last = performanceDiagnostics.snapshot().charts.main.last;
    assert.ok(last.pixelsPerBucket > 2, 'completed gesture observations can reduce excessive draw work');
    assert.equal(last.refreshIntervalMs, 0);
    assert.equal(last.refreshSource, 'interaction');
    assert.equal(state.chartSeries.x.length, 5000);
    await paintFeedback();
  }
});

test('recording and review budgets are independent and release preserves the gesture budget', async () => {
  seed(true);
  await submit();
  await frame(120);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 8);
  chart.setRangeDragging(true);
  chart.setChartXWindow(0.1, 4.9);
  chart.updateCharts('interaction');
  await Promise.resolve();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 2);
  const during = state.mainChart.data.map((col) => col.slice());
  chart.setRangeDragging(false);
  chart.updateCharts('interaction');
  await Promise.resolve();
  assert.deepEqual(state.mainChart.data, during);
  append(100);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 8);
  await paintFeedback();
});

for (const source of ['interaction', 'maintenance'])
  test(`${source} supersedes a pending high-rate live timer and submits at the next frame`, async () => {
    seed(true);
    await submit();
    await paintFeedback();
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    let paced = false;
    let cancelled = false;
    globalThis.setTimeout = () => {
      paced = true;
      return 9999;
    };
    globalThis.clearTimeout = () => {
      cancelled = true;
    };
    try {
      time -= 40; // The next append is due before the 50ms live refresh interval.
      append(10);
      chart.scheduleChartUpdate('live');
      assert.equal(paced, true);
      chart.setChartXWindow(0.2, 4.5);
      chart.scheduleChartUpdate(source);
      await frame(16);
      assert.equal(cancelled, true);
      const last = performanceDiagnostics.snapshot().charts.main.last;
      assert.equal(last.refreshSource, source);
      assert.equal(last.refreshIntervalMs, 0);
    } finally {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
      await paintFeedback();
    }
  });

test('render diagnostics remain bounded while reporting next-frame delay', () => {
  performanceDiagnostics.reset();
  for (let i = 0; i < 600; i++) {
    const request = performanceDiagnostics.chartRequest('main', { sourcePointCount: 100000, displayPointCount: 400 });
    const entry = performanceDiagnostics.chartPaint('main', request, time, 0.4);
    performanceDiagnostics.chartNextFrame(entry, 11);
  }
  const metrics = performanceDiagnostics.snapshot().charts.main;
  assert.equal(metrics.count, 512);
  assert.equal(metrics.nextFrameDelay.p95Ms, 11);
  assert.equal(metrics.last.displayPointCount, 400);
});

test('delayed idle candidates cannot normalize raster lag into the refresh baseline', async () => {
  performanceDiagnostics.reset();
  performanceDiagnostics.start();
  for (let i = 0; i < 24; i++) await frame(8);
  assert.equal(performanceDiagnostics.idleFrameIntervalMs(), 8);
  for (let i = 0; i < 8; i++) await frame(48);
  assert.equal(performanceDiagnostics.idleFrameIntervalMs(), 8);
  assert.equal(performanceDiagnostics.frameDelaySince(time - 50), 48);
  assert.equal(performanceDiagnostics.frameDelaySince(time + 1), 0);
});
