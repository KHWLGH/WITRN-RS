import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { environment, options, provenance, quantiles, saveJson } from './common.mjs';
import { CHANNELS, fixture, segmentsFixture } from './fixtures.mjs';

const config = options(process.argv.slice(2), {
  sizes: [1000000, 5000000],
  runs: 5,
  warmup: 1,
  baseline: 'bench/results/phase3-before/src',
  output: 'bench/results/phase3.json',
});
const loadOld = (file) => import(pathToFileURL(resolve(config.baseline, file)));
const oldState = await loadOld('state.js');
const oldStats = await loadOld('range-stats.js');
const oldMeasure = await loadOld('measurement.js');
const { emptyChartColumns } = await import('../src/state.js');
const { captureRangeStatsSnapshot, computeRangeStatsSync } = await import('../src/range-stats.js');
const { calculateEnergyInRange, estimateIntervalMsFromX } = await import('../src/measurement.js');

const result = {
  config,
  environment: environment(),
  provenance: await provenance(),
  cases: [],
  limitations: [
    'Node in-process timings include GC and do not represent browser frame pacing.',
    'Retained bytes count backing Float64Array allocation; object headers and temporary arrays are excluded.',
  ],
};
const numericStats = (stats) =>
  Object.fromEntries(Object.entries(stats).filter(([key]) => key !== 'columns' && key !== 'revision'));
const measure = (fn) => {
  const start = performance.now();
  const value = fn();
  return { value, elapsedMs: performance.now() - start };
};

for (const n of config.sizes) {
  const f = fixture(n);
  const arrays = {
    x: f.x,
    timestamps: f.timestamps,
    ...Object.fromEntries(CHANNELS.map((key, i) => [key, f.ys[i]])),
    recordingSegments: segmentsFixture(n),
  };
  const inputHash = createHash('sha256');
  for (const values of Object.values(arrays)) inputHash.update(new Uint8Array(values.buffer));
  const oldCols = oldState.emptyChartColumns(1);
  const newCols = emptyChartColumns(1);
  const item = { size: n, inputSha256: inputHash.digest('hex'), runs: [], summaries: {} };
  const setup = {};
  for (const [name, cols] of [
    ['before', oldCols],
    ['after', newCols],
  ]) {
    setup[name] = measure(() => {
      for (const [key, values] of Object.entries(arrays)) cols[key].set(values);
    }).elapsedMs;
  }
  item.setupMs = setup;
  item.retainedColumnBytes = {
    before: Object.values(oldCols).reduce((sum, col) => sum + col.buf.byteLength, 0),
    after: Object.values(newCols).reduce((sum, col) => sum + col.byteLength, 0),
  };
  const from = 7;
  const to = n - 8;
  for (let run = -config.warmup; run < config.runs; run++) {
    globalThis.gc?.();
    const order = run % 2 ? ['after', 'before'] : ['before', 'after'];
    const measured = {};
    for (const name of order) {
      const cols = name === 'before' ? oldCols : newCols;
      const stats = name === 'before' ? oldStats : { captureRangeStatsSnapshot, computeRangeStatsSync };
      const energy = name === 'before' ? oldMeasure : { calculateEnergyInRange, estimateIntervalMsFromX };
      const inputs =
        name === 'before'
          ? {
              x: cols.x.view(),
              current: cols.current.view(),
              power: cols.power.view(),
              segments: cols.recordingSegments.view(),
            }
          : { x: cols.x, current: cols.current, power: cols.power, segments: cols.recordingSegments };
      measured[name] = {};
      measured[name].snapshot = measure(() => stats.captureRangeStatsSnapshot(cols, from, to, 2));
      measured[name].rangeStats = measure(() => stats.computeRangeStatsSync(measured[name].snapshot.value));
      measured[name].energy = measure(() =>
        energy.calculateEnergyInRange(inputs.x, inputs.current, inputs.power, from, to, inputs.segments, 10),
      );
      measured[name].interval = measure(() => energy.estimateIntervalMsFromX(inputs.x));
    }
    assert.deepStrictEqual(
      numericStats(measured.after.rangeStats.value),
      numericStats(measured.before.rangeStats.value),
    );
    assert.deepStrictEqual(measured.after.energy.value, measured.before.energy.value);
    assert.equal(measured.after.interval.value, measured.before.interval.value);
    if (run >= 0)
      item.runs.push(
        Object.fromEntries(
          Object.entries(measured).map(([name, tasks]) => [
            name,
            Object.fromEntries(Object.entries(tasks).map(([key, sample]) => [key, sample.elapsedMs])),
          ]),
        ),
      );
  }
  for (const name of ['before', 'after'])
    item.summaries[name] = Object.fromEntries(
      ['snapshot', 'rangeStats', 'energy', 'interval'].map((key) => [
        key,
        quantiles(item.runs.map((r) => r[name][key])),
      ]),
    );
  const appendCount = Math.max(10000, Math.floor(n * 0.05));
  const append = {};
  for (const [name, cols] of [
    ['before', oldCols],
    ['after', newCols],
  ]) {
    append[name] = measure(() => {
      for (let i = 0; i < appendCount; i++) {
        const value = n + i;
        for (const col of Object.values(cols)) col.push(value);
      }
    }).elapsedMs;
  }
  item.append = {
    count: appendCount,
    elapsedMs: append,
    retainedColumnBytes: {
      before: Object.values(oldCols).reduce((sum, col) => sum + col.buf.byteLength, 0),
      after: Object.values(newCols).reduce((sum, col) => sum + col.byteLength, 0),
    },
  };
  for (const key of Object.keys(oldCols)) {
    assert.equal(newCols[key].length, oldCols[key].length);
    assert.equal(newCols[key].valueAt(n), oldCols[key].at(n));
    assert.equal(newCols[key].valueAt(n + appendCount - 1), oldCols[key].at(-1));
  }
  result.cases.push(item);
  console.log(JSON.stringify({ size: n, summaries: item.summaries, retainedColumnBytes: item.retainedColumnBytes }));
  await saveJson(config.output, result);
}
console.log(
  JSON.stringify({
    output: await saveJson(config.output, result),
    exactness: 'Object.is-equivalent statistics, energy and append values',
  }),
);
