import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = {
  hidden: false,
  documentElement: {},
  addEventListener() {},
  getElementById: (id) => (id.endsWith('-chart') ? { clientWidth: 100, clientHeight: 300 } : null),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.uPlot = class {
  static paths = { spline: () => () => 'spline', linear: () => () => 'linear' };
  constructor(options, data) {
    Object.assign(this, { options, data, width: options.width, height: options.height, hooks: {} });
  }
  setData(data) {
    this.data = data;
  }
  setScale() {}
  redraw() {}
  posToVal(value) {
    return value;
  }
  valToPos(value) {
    return value;
  }
};

test('envelope hover resolves pointer time to the raw sample; marker uses that same value', async () => {
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const cols = emptyChartColumns(5000);
  for (let i = 0; i < 5000; i++)
    for (const [key, col] of Object.entries(cols)) col.push(key === 'x' ? i : key === 'temp' ? NaN : i * 2);
  setChartColumns(cols);
  state.settings.activeView = 'monitor';
  chart.initChart();
  chart.setChartXWindow(0, 4999);
  chart.updateCharts();
  const u = state.mainChart;
  u.cursor = { idx: 42, left: 4123.4, top: 20 };
  assert.equal(u.options.cursor.dataIdx(u, 1, 42), 42);
  assert.deepEqual(u.options.cursor.points.bbox(u, 1), { left: 4119, top: 8242, width: 8, height: 8 });
  assert.equal(u.options.cursor.dataIdx(u, 4, 42), null);
  assert.equal(u.options.cursor.points.bbox(u, 4).width, 0);
  assert.equal(
    u.options.series[1].paths(u, 1, 0, u.data[0].length - 1),
    'linear',
    'short envelope still has duplicate x',
  );
  chart.setChartXWindow(1200, 1210);
  chart.updateCharts();
  assert.equal(u.options.series[1].paths(u, 1, 1200, 1210), 'spline');
  u.cursor.left = -1;
  assert.equal(u.options.cursor.dataIdx(u, 1, 42), null);
});

test('dense recording and review retain unpressured fills at every sample rate and respect user zero', async () => {
  const { state } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const u = state.mainChart;
  chart.setChartXWindow(0, 4999);
  state.isRecording = true;
  for (const sampleRate of [1, 10, 250, 1000]) {
    state.settings.sampleRate = sampleRate;
    chart.updateCharts();
    assert.equal(typeof u.options.series[1].fill(), 'string');
  }
  state.isRecording = false;
  chart.updateCharts();
  assert.equal(typeof u.options.series[1].fill(), 'string', 'density alone does not suppress paused fill');
  chart.setSeriesFill(1, 0);
  chart.setChartXWindow(1200, 1210);
  chart.updateCharts();
  assert.equal(typeof u.options.series[1].fill(), 'string');
  assert.equal(u.options.series[2].fill(), null, 'a disabled user fill stays disabled after zoom');
  state.isRecording = true;
  chart.updateCharts();
  assert.equal(typeof u.options.series[1].fill(), 'string', 'sparse recording also restores the configured fill');
  assert.equal(u.data[0].length, 13, 'sparse windows keep raw points and clipping neighbours');
  state.isRecording = false;
});
