import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCooperativeSlices } from '../src/cooperative.js';
import { captureRangeStatsSnapshot, computeRangeStatsAsync } from '../src/range-stats.js';
import { environment, options, provenance, quantiles, saveJson } from './common.mjs';
import { CHANNELS, fixture } from './fixtures.mjs';

const config = options(process.argv.slice(2), {
  sizes: [1000000, 5000000],
  runs: 10,
  warmup: 3,
  hz: 1000,
  baseline: 'bench/results/phase2-before/src',
  output: 'bench/results/phase2-algorithms.json',
});
globalThis.document = { hidden: false, getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };
const load = (root, file) => import(pathToFileURL(resolve(root, file)));
const oldData = await load(config.baseline, 'data.js');
const oldState = (await load(config.baseline, 'state.js')).state;
const { state, emptyChartColumns } = await import('../src/state.js');
const OldIndex = (await load(config.baseline, 'chart-extrema.js')).ExactExtremaIndex;
const NewIndex = (await import('../src/chart-extrema.js')).ExactExtremaIndex;
const OldBuckets = (await load(config.baseline, 'chart-buckets.js')).SeriesBuckets;
const NewBuckets = (await import('../src/chart-buckets.js')).SeriesBuckets;
const result = {
  config,
  environment: environment(),
  provenance: await provenance(),
  cases: [],
  limitations: [
    'Node algorithm timings, not UI FPS or physical device validation.',
    'Alternating before/after order in one process; timers and allocation may include OS/GC noise.',
    'Cooperative slices are observed between yield calls; allocation/GC is included, not a hard real-time guarantee.',
  ],
};
const immediate = () => new Promise((resolve) => setImmediate(resolve));
async function measure(work) {
  const slices = [];
  const started = performance.now();
  let sliceStart = started;
  const yieldTask = async () => {
    slices.push(performance.now() - sliceStart);
    await immediate();
    sliceStart = performance.now();
  };
  const value = await work(yieldTask);
  slices.push(performance.now() - sliceStart);
  return { value, elapsedMs: performance.now() - started, maxSliceMs: Math.max(...slices), slices: slices.length };
}
const numericStats = (stats) => Object.fromEntries(Object.entries(stats).filter(([key]) => key !== 'columns'));
for (const n of config.sizes) {
  const intervalMs = 1000 / config.hz;
  const f = fixture(n, undefined, intervalMs);
  const cols = emptyChartColumns(1);
  const arrays = {
    x: f.x,
    timestamps: f.timestamps,
    ...Object.fromEntries(CHANNELS.map((key, i) => [key, f.ys[i]])),
    recordingSegments: new Float64Array(n).fill(NaN),
  };
  for (const [key, array] of Object.entries(arrays)) Object.assign(cols[key], { buf: array, length: n });
  state.chartSeries = cols;
  oldState.chartSeries = cols;
  for (const s of [state, oldState]) {
    s.dataIntervalMs = intervalMs;
    s.settings.statsRange = true;
    s.settings.activeView = 'monitor';
  }
  const hash = createHash('sha256');
  for (const array of Object.values(arrays)) hash.update(new Uint8Array(array.buffer));
  const item = { size: n, inputSha256: hash.digest('hex'), columnBytes: n * 11 * 8, runs: [], summaries: {} };
  for (let run = -config.warmup; run < config.runs; run++) {
    globalThis.gc?.();
    const from = run + config.warmup + 1;
    const to = n - from - 1;
    oldState.chartWindow = { mode: 'frozen', min: f.x[from], max: f.x[to], duration: f.x[to] - f.x[from] };
    const snapshot = captureRangeStatsSnapshot(cols, from, to, 2);
    const tasks = {
      statsBefore: () => measure(() => oldData.getRangeStats()),
      statsAfter: () => measure((yieldTask) => computeRangeStatsAsync(snapshot, { yieldTask })),
      indexBefore: () =>
        measure(() => {
          const index = new OldIndex();
          index.sync(f.ys, n);
          return index;
        }),
      indexAfter: () =>
        measure(async (yieldTask) => {
          const index = new NewIndex();
          await runCooperativeSlices(() => index.syncStep(f.ys, n), { yieldTask });
          return index;
        }),
    };
    const measured = {};
    for (const key of run % 2 ? Object.keys(tasks).reverse() : Object.keys(tasks)) measured[key] = await tasks[key]();
    assert.deepStrictEqual(numericStats(measured.statsAfter.value), numericStats(measured.statsBefore.value));
    item.indexBytes = { before: measured.indexBefore.value.byteLength, after: measured.indexAfter.value.byteLength };
    const before = new OldBuckets();
    before.rebuild(f.x, f.ys, from, to, 1200, measured.indexBefore.value);
    const after = new NewBuckets();
    const step = after.beginRebuild(f.x, f.ys, from, to, 1200, measured.indexAfter.value);
    await runCooperativeSlices(() => step(16384), { yieldTask: immediate });
    assert.deepStrictEqual(after.flatten(), before.flatten());
    if (run >= 0)
      item.runs.push(Object.fromEntries(Object.entries(measured).map(([key, { value, ...timing }]) => [key, timing])));
  }
  for (const name of ['statsBefore', 'statsAfter', 'indexBefore', 'indexAfter']) {
    item.summaries[name] = {
      elapsedMs: quantiles(item.runs.map((r) => r[name].elapsedMs)),
      maxSliceMs: quantiles(item.runs.map((r) => r[name].maxSliceMs)),
    };
  }
  result.cases.push(item);
  console.log(JSON.stringify({ size: n, summaries: item.summaries }));
}
console.log(
  JSON.stringify({
    output: await saveJson(config.output, result),
    exactness: 'all statistics and projections deepStrictEqual',
  }),
);
