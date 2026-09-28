import assert from 'node:assert/strict';
import test from 'node:test';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { ExactExtremaIndex } from '../src/chart-extrema.js';
import { runCooperativeSlices } from '../src/cooperative.js';

test('partially published extrema prefixes and partial stripes exactly match raw folding', () => {
  const n = 18017;
  const xs = Float64Array.from({ length: n }, (_, i) => Math.floor(i / 2));
  const ys = Array.from({ length: 8 }, (_, s) =>
    Float64Array.from(xs, (_, i) => (i % 41 === 0 ? NaN : s === 7 ? (i % 2 ? -0 : 0) : (i % 101) - 50)),
  );
  const index = new ExactExtremaIndex();
  for (let step = 0; step < 8; step++) {
    index.syncStep(ys, n, 7);
    const ref = new SeriesBuckets();
    ref.rebuild(xs, ys, 17, n - 13, 127);
    const actual = new SeriesBuckets();
    const advance = actual.beginRebuild(xs, ys, 17, n - 13, 127, index);
    while (!advance(19)) {}
    assert.deepStrictEqual(actual.list, ref.list);
    assert.deepStrictEqual(actual.flatten(), ref.flatten());
  }
});

test('cooperative work gives control back before its first step and stops on cancellation', async () => {
  let steps = 0,
    yields = 0;
  const done = await runCooperativeSlices(
    () => {
      steps++;
      return steps === 10;
    },
    {
      now: () => steps * 2,
      yieldTask: async () => {
        yields++;
      },
      isCancelled: () => yields === 3,
    },
  );
  assert.equal(done, false);
  assert.equal(steps, 2);
});

test('large chart preparations publish a complete projection and discard replaced history', async () => {
  const attrs = new Map();
  const host = { clientWidth: 1200, setAttribute: (key, value) => attrs.set(key, value) };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const columns = emptyChartColumns(300007);
  for (let i = 0; i < 300007; i++) {
    for (const [key, col] of Object.entries(columns))
      col.push(key === 'x' ? i : key === 'recordingSegments' ? 1 : i % 101);
  }
  state.settings.activeView = 'monitor';
  state.mainChart = {
    width: 1200,
    setData(data) {
      this.data = data;
    },
    setScale() {},
  };
  state.navigatorChart = null;
  setChartColumns(columns);
  chart.syncChartSeries();
  chart.setChartXWindow(0, columns.x.length - 1);
  chart.updateCharts();
  assert.equal(attrs.get('aria-busy'), 'true');
  assert.equal(state.mainChart.data, undefined, 'no partial raw fallback is published');
  while (attrs.get('aria-busy') === 'true') await new Promise((resolve) => setTimeout(resolve, 2));
  const expected = new SeriesBuckets();
  expected.rebuild(
    columns.x.view(),
    ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'].map((key) => columns[key].view()),
    0,
    columns.x.length,
    1200,
  );
  const flat = expected.flatten();
  assert.deepStrictEqual(state.mainChart.data, [flat.x, ...flat.ys]);
  chart.syncChartSeries();
  chart.updateCharts();
  setChartColumns(emptyChartColumns(1));
  chart.syncChartSeries();
  chart.updateCharts();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.mainChart.data[0].length, 0);
  assert.equal(attrs.get('aria-busy'), 'false');
});
