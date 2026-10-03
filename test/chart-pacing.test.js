import assert from 'node:assert/strict';
import test from 'node:test';
import { ChartFillPolicy, ChartRenderPolicy, liveChartIntervalMs } from '../src/chart-pacing.js';

function feedback(policy, delayMs, at, overrides = {}) {
  return policy.observe({ delayMs, at, visible: true, dense: true, idleFrameMs: 16, ...overrides });
}

test('density responds to consecutive slow frames and a single severe frame, within bounded levels', () => {
  const policy = new ChartRenderPolicy();
  assert.equal(policy.pixelsPerBucket, 2);
  assert.equal(feedback(policy, 40, 100), false);
  assert.equal(feedback(policy, 40, 200), true);
  assert.equal(policy.pixelsPerBucket, 4);
  assert.equal(feedback(policy, 120, 350), true);
  assert.equal(policy.pixelsPerBucket, 16);
  assert.equal(feedback(policy, 120, 500), false);
  assert.equal(policy.pixelsPerBucket, 16);
  policy.reset();
  assert.equal(policy.pixelsPerBucket, 2);
});

test('a healthy frame interrupts slow feedback and the idle interval determines the threshold', () => {
  const policy = new ChartRenderPolicy();
  feedback(policy, 40, 100);
  feedback(policy, 16, 150);
  assert.equal(feedback(policy, 40, 200), false);
  assert.equal(feedback(policy, 40, 250, { idleFrameMs: 25 }), false);
  assert.equal(policy.pixelsPerBucket, 2);
});

test('continuous interaction lowers the budget after measured pressure without sacrificing healthy detail', () => {
  const policy = new ChartRenderPolicy();
  assert.equal(feedback(policy, 16, 100, { interactive: true }), false);
  assert.equal(policy.pixelsPerBucket, 2);
  assert.equal(feedback(policy, 40, 150, { interactive: true }), true);
  assert.equal(policy.pixelsPerBucket, 4);
  assert.equal(feedback(policy, 40, 200, { interactive: true }), true);
  assert.equal(policy.pixelsPerBucket, 8);
});

test('recovery requires two continuous healthy seconds and five seconds between changes', () => {
  const policy = new ChartRenderPolicy();
  feedback(policy, 110, 100);
  assert.equal(policy.pixelsPerBucket, 8);
  for (let at = 200; at < 5100; at += 100) assert.equal(feedback(policy, 16, at), false);
  assert.equal(feedback(policy, 16, 5100), true);
  assert.equal(policy.pixelsPerBucket, 4);
  for (let at = 5200; at < 10100; at += 100) assert.equal(feedback(policy, 16, at), false);
  assert.equal(feedback(policy, 16, 10100), true);
  assert.equal(policy.pixelsPerBucket, 2);
  for (let at = 10200; at <= 20100; at += 100) feedback(policy, 16, at);
  assert.equal(policy.pixelsPerBucket, 1);
});

test('hidden, sparse, invalid and interrupted feedback never establish recovery', () => {
  const policy = new ChartRenderPolicy();
  feedback(policy, 110, 100);
  feedback(policy, 16, 200);
  assert.equal(feedback(policy, 110, 300, { visible: false }), false);
  assert.equal(feedback(policy, 16, 6000), false);
  assert.equal(feedback(policy, 16, 6100, { dense: false }), false);
  assert.equal(feedback(policy, NaN, 6200), false);
  assert.equal(feedback(policy, 16, 10000), false);
  assert.equal(policy.pixelsPerBucket, 8);
  assert.equal(feedback(policy, 40, 10100), false);
  feedback(policy, 40, 10200, { visible: false });
  assert.equal(feedback(policy, 40, 10300), false);
});

test('100Hz retains cheap dense refreshes; 1000Hz reserves 50–100ms including raster pressure', () => {
  assert.equal(liveChartIntervalMs(0.4, true, 16, 16), 0);
  assert.equal(liveChartIntervalMs(0.4, true, 85, 16), 100);
  assert.equal(liveChartIntervalMs(12, true, 16, 16), 36);
  assert.equal(liveChartIntervalMs(0.4), 0);
  assert.equal(liveChartIntervalMs(NaN, true), 0);
  assert.equal(liveChartIntervalMs(0.4, true, 16, 16, 1), 50);
  assert.equal(liveChartIntervalMs(0.4, false, 16, 16, 1), 50);
  assert.equal(liveChartIntervalMs(12, true, 16, 16, 1), 50);
  assert.equal(liveChartIntervalMs(0.4, true, 85, 16, 1), 100);
  assert.equal(liveChartIntervalMs(0.4, true, 16, 16, NaN), 0);
});

function fillFeedback(fill, render, delayMs, at, overrides = {}) {
  const paintedDensity = render.pixelsPerBucket;
  render.observe({ delayMs, at, idleFrameMs: 16, visible: true, dense: true });
  return fill.observe({
    delayMs,
    at,
    idleFrameMs: 16,
    visible: true,
    eligible: true,
    paintedDensity,
    nextDensity: render.pixelsPerBucket,
    ...overrides,
  });
}

test('fill requires a slow pair after a density reduction actually painted', () => {
  const fill = new ChartFillPolicy(),
    render = new ChartRenderPolicy();
  for (const at of [100, 200]) assert.equal(fillFeedback(fill, render, 40, at), false);
  assert.equal(render.pixelsPerBucket, 4);
  assert.equal(fill.suppressed, false);
  assert.equal(fillFeedback(fill, render, 40, 300), false);
  assert.equal(fill.needsConfirmation, true);
  assert.equal(fillFeedback(fill, render, 40, 400), true);
  assert.equal(fill.reason, 'persistent-slow-frame');
  assert.equal(fill.suppressed, true);
});

test('fill remembers the first gesture reduction but requires a slower paint at that density', () => {
  const fill = new ChartFillPolicy();
  const observe = (delayMs, at, paintedDensity, nextDensity) =>
    fill.observe({ delayMs, at, idleFrameMs: 16, visible: true, eligible: true, paintedDensity, nextDensity });
  assert.equal(observe(40, 100, 2, 4), false);
  assert.equal(fill.suppressed, false);
  assert.equal(observe(16, 150, 4, 4), false);
  assert.equal(observe(40, 200, 4, 8), false);
  assert.equal(observe(40, 250, 8, 16), true);
  assert.equal(fill.reason, 'persistent-slow-frame');
});

test('severe frames protect immediately; maximum density needs a bounded confirmation', () => {
  const fill = new ChartFillPolicy(),
    render = new ChartRenderPolicy();
  assert.equal(fillFeedback(fill, render, 120, 100), true);
  assert.equal(fill.reason, 'severe-frame');
  fill.reset();
  render.pixelsPerBucket = 16;
  assert.equal(fillFeedback(fill, render, 40, 200), false);
  assert.equal(fill.needsConfirmation, true);
  assert.equal(fillFeedback(fill, render, 40, 300), true);
  assert.equal(fill.needsConfirmation, false);
});

test('fill trials require healthy paints for two seconds and wait five seconds after suppression', () => {
  const fill = new ChartFillPolicy(),
    render = new ChartRenderPolicy();
  fillFeedback(fill, render, 120, 100);
  for (let at = 200; at < 5100; at += 100) {
    assert.equal(fillFeedback(fill, render, 16, at), false);
    assert.equal(fill.suppressed, true);
  }
  assert.equal(fillFeedback(fill, render, 16, 5100), true);
  assert.equal(fill.suppressed, false);
  assert.equal(fill.reason, null);
});

test('unrelated, invalid and hidden feedback cannot suppress or restore fills', () => {
  const fill = new ChartFillPolicy(),
    render = new ChartRenderPolicy();
  fillFeedback(fill, render, 40, 100);
  fillFeedback(fill, render, 40, 1000);
  assert.equal(fill.suppressed, false, 'a gap cannot confirm the first slow sample');
  fillFeedback(fill, render, 120, 1100, { eligible: false });
  assert.equal(fill.suppressed, false);
  fillFeedback(fill, render, 120, 1200);
  fillFeedback(fill, render, 16, 1300);
  fillFeedback(fill, render, 16, 8000);
  assert.equal(fill.suppressed, true, 'background-sized gaps cannot prove recovery');
  assert.equal(fillFeedback(fill, render, 120, 8100, { visible: false }), true);
  assert.equal(fill.reason, null);
  fillFeedback(fill, render, NaN, 8200);
  assert.equal(fill.suppressed, false);
});
