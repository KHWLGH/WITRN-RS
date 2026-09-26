import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { ExactExtremaIndex } from '../src/chart-extrema.js';
import { environment, inputHash, options, provenance, quantiles, saveJson } from './common.mjs';
import { fixture, SEED, VERSION } from './fixtures.mjs';

const config = options(process.argv.slice(2), {
  sizes: [10000, 100000, 1000000],
  runs: 20,
  warmup: 5,
  output: 'bench/results/extrema.json',
});
const before = await provenance();
const result = {
  schema: 'witrn-extrema-v1',
  config,
  environment: environment(),
  fixture: { version: VERSION, seed: SEED },
  provenanceBefore: before,
  cases: [],
  limitations: [
    'Node algorithms only; not UI FPS',
    'Alternating pairs in one process; not independent process runs',
    'Index cold-build and memory are reported separately from warm window queries',
    'No forced GC; concurrent system workload and power mode are not controlled',
  ],
};
for (const n of config.sizes) {
  const f = fixture(n);
  const index = new ExactExtremaIndex();
  index.sync(f.ys, n);
  const reference = new SeriesBuckets();
  const indexed = new SeriesBuckets();
  for (const offset of [0, 1, 31, 33, 517]) {
    reference.rebuild(f.x, f.ys, offset, n - offset, 1200);
    indexed.rebuild(f.x, f.ys, offset, n - offset, 1200, index);
    assert.deepStrictEqual(indexed.list, reference.list);
    assert.deepStrictEqual(indexed.flatten(), reference.flatten());
  }
  const rawMs = { rebuildScan: [], rebuildIndexed: [], coldBuild: [], append100: [] };
  for (let run = -config.warmup; run < config.runs; run++) {
    const offset = (run + config.warmup) % 19;
    const queries = [
      ['rebuildScan', () => reference.rebuild(f.x, f.ys, offset, n - 23 + offset, 1200)],
      ['rebuildIndexed', () => indexed.rebuild(f.x, f.ys, offset, n - 23 + offset, 1200, index)],
    ];
    if (run % 2) queries.reverse();
    for (const [name, fn] of queries) {
      const start = performance.now();
      fn();
      if (run >= 0) rawMs[name].push(performance.now() - start);
    }
    assert.deepStrictEqual(indexed.list, reference.list);
    const cold = new ExactExtremaIndex();
    const buildStart = performance.now();
    cold.sync(f.ys, n - 100);
    const buildMs = performance.now() - buildStart;
    const appendStart = performance.now();
    cold.sync(f.ys, n);
    const appendMs = performance.now() - appendStart;
    if (run >= 0) {
      rawMs.coldBuild.push(buildMs);
      rawMs.append100.push(appendMs);
    }
  }
  const ms = Object.fromEntries(Object.entries(rawMs).map(([name, values]) => [name, quantiles(values)]));
  const pairedDifferenceMs = rawMs.rebuildIndexed.map((v, i) => v - rawMs.rebuildScan[i]);
  const item = {
    size: n,
    inputSha256: inputHash(f),
    golden: 'deepStrictEqual including signed zero and NaN; no tolerance',
    indexedPathEnabled: Math.ceil(n / 1200) >= 128,
    indexCapacityBytes: index.byteLength,
    rawColumnBytes: (1 + f.ys.length) * n * 8,
    rawMs,
    ms,
    pairedDifferenceMs,
    pairedDifference: quantiles(pairedDifferenceMs),
    relativeP50Change: ms.rebuildIndexed.p50 / ms.rebuildScan.p50 - 1,
  };
  result.cases.push(item);
  console.log(
    JSON.stringify({
      size: n,
      scanP50ms: ms.rebuildScan.p50,
      indexedP50ms: ms.rebuildIndexed.p50,
      coldP50ms: ms.coldBuild.p50,
      append100P50ms: ms.append100.p50,
      indexCapacityBytes: index.byteLength,
    }),
  );
}
result.provenanceAfter = await provenance();
result.sourceStable = before.sourceSha256 === result.provenanceAfter.sourceSha256;
console.log(JSON.stringify({ output: await saveJson(config.output, result), sourceStable: result.sourceStable }));
