import assert from 'node:assert/strict';
import test from 'node:test';

const hosts = new Map([
  ['main-chart', { clientWidth: 1200, clientHeight: 300 }],
  ['navigator-chart', { clientWidth: 1200, clientHeight: 46 }],
]);
const resizeCallbacks = new Map();
const frames = new Map();
let nextFrame = 0;
globalThis.document = {
  hidden: false,
  documentElement: {},
  getElementById: (id) => hosts.get(id) ?? null,
  addEventListener() {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe(host) {
    resizeCallbacks.set(host, this.callback);
  }
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.uPlot = class {
  constructor(options, data) {
    this.width = options.width;
    this.height = options.height;
    this.hooks = options.hooks ?? {};
    this.data = data;
    this.submissions = 0;
    this.resizes = 0;
  }
  setSize({ width, height }) {
    this.width = width;
    this.height = height;
    this.resizes++;
    for (const hook of this.hooks.setSize ?? []) hook(this);
  }
  setData(data) {
    this.data = data;
    this.submissions++;
  }
  setScale() {}
};

const { state } = await import('../src/state.js');
const { initChart, scheduleChartUpdate } = await import('../src/chart.js');

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) frame(performance.now());
}

test('simultaneous main and navigator resize commit their data once in one frame', () => {
  initChart();
  const main = state.mainChart;
  const nav = state.navigatorChart;
  for (const host of hosts.values()) {
    host.clientWidth = 900;
    host.clientHeight += 80;
    resizeCallbacks.get(host)();
  }
  scheduleChartUpdate();
  assert.equal(frames.size, 1, 'two observers and data invalidation share a frame');
  flushFrames();
  assert.equal(main.resizes, 1);
  assert.equal(nav.resizes, 1);
  assert.equal(main.submissions, 1, 'main resize callback must not submit a second time');
  assert.equal(nav.submissions, 1, 'navigator resize callback must not submit a second time');
  assert.equal(frames.size, 0, 'size hooks must not leave an unnecessary animation loop');

  for (const callback of resizeCallbacks.values()) callback();
  flushFrames();
  assert.equal(main.resizes, 1, 'unchanged geometry needs no further resize');
  assert.equal(main.submissions, 1, 'unchanged geometry needs no further data submission');
  assert.equal(nav.submissions, 1);
});
