import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { calculateEnergy, calculateEnergyInRange, isRecordingBoundary } from '../src/measurement.js';
import { F64Col } from '../src/state.js';
import {
  corroboration,
  environment,
  inputHash,
  mergeProjections,
  options,
  projectBaseline,
  provenance,
  quantiles,
  readJson,
  renderComparison,
  saveJson,
  sha256,
  verifyBaseline,
} from './common.mjs';
import {
  boundaryFixture,
  canonicalBytes,
  fixture,
  SEED,
  SEGMENTS_VERSION,
  SIZES,
  segmentsFixture,
  VERSION,
} from './fixtures.mjs';

export const BASELINE_PATH = 'bench/baselines/core.json';
/** Deliberately no @10_000: whole-op cost there is 0.03-0.9ms and a real change does not
 * separate from jitter. Keys are op@size so a rename fails loudly instead of silently
 * dropping a metric from the gate. */
export const GATED = [
  'F64Col.push.8channels',
  'SeriesBuckets.rebuild.full',
  'SeriesBuckets.flatten.reused',
  'integrateEnergy.nullSegments',
  'integrateEnergy.withSegments',
].flatMap((name) => [`${name}@100000`, `${name}@1000000`]);

export function referenceEnergy(times, current, power, divisor, start = 0, end = times.length - 1, segments = null) {
  let wh = 0,
    mah = 0;
  for (let i = Math.max(start, 0) + 1; i <= Math.min(end, times.length - 1); i++) {
    if (isRecordingBoundary(segments, i)) continue;
    const hours = (times[i] - times[i - 1]) / divisor;
    const amps = Math.abs(current[i]),
      watts = Math.abs(power[i]);
    if (!Number.isFinite(hours) || hours < 0 || hours * 3600 > 2 || !Number.isFinite(amps) || !Number.isFinite(watts))
      continue;
    wh += watts * hours;
    mah += amps * 1000 * hours;
  }
  return { wh, mah };
}
export function referenceBuckets(f, start, end, capacity) {
  const step = Math.max(1, Math.ceil((end - start) / Math.max(64, capacity | 0)));
  const list = [];
  for (let from = start; from < end; from += step) {
    const to = Math.min(from + step, end);
    const min = [],
      max = [];
    for (const col of f.ys) {
      let low = NaN,
        high = NaN;
      for (let i = from; i < to; i++)
        if (Number.isFinite(col[i])) {
          if (!Number.isFinite(low) || col[i] < low) low = col[i];
          if (!Number.isFinite(high) || col[i] > high) high = col[i];
        }
      min.push(low);
      max.push(high);
    }
    list.push({ x0: f.x[from], x1: f.x[to - 1], n: to - from, min, max });
  }
  return list;
}
export function golden(f, segments) {
  const cols = [f.x, f.timestamps, ...f.ys];
  const copies = cols.map((source) => {
    const col = new F64Col(1);
    for (const x of source) col.push(x);
    assert.equal(col.length, f.size);
    assert.deepStrictEqual(col.view(), source);
    return col;
  });
  assert.equal(sha256(canonicalBytes(copies.map((c) => c.view()))), inputHash(f));
  for (const [start, end, cap] of [
    [0, f.size, 1200],
    [7, f.size - 1, 64],
    [1, Math.min(3, f.size), 64],
  ]) {
    if (end <= start) continue;
    const b = new SeriesBuckets();
    b.rebuild(f.x, f.ys, start, end, cap);
    const expected = referenceBuckets(f, start, end, cap);
    assert.deepStrictEqual(b.list, expected);
    const flat = b.flatten();
    assert.equal(flat.x.length, expected.length * 2);
    expected.forEach((v, i) => {
      assert.ok(Object.is(flat.x[i * 2], (v.x0 + v.x1) / 2));
      assert.ok(Object.is(flat.x[i * 2 + 1], (v.x0 + v.x1) / 2));
      for (let s = 0; s < 8; s++) {
        assert.ok(Object.is(flat.ys[s][i * 2], v.min[s]));
        assert.ok(Object.is(flat.ys[s][i * 2 + 1], v.max[s]));
      }
    });
  }
  const energy = referenceEnergy(f.timestamps, f.ys[1], f.ys[2], 3600000);
  assert.deepStrictEqual(calculateEnergy(f.timestamps, f.ys[1], f.ys[2]), energy);
  // 分段守卫既不能改变 segments=null 的结果，也必须真的跳过边界。
  const segmented = calculateEnergy(f.timestamps, f.ys[1], f.ys[2], segments);
  assert.deepStrictEqual(segmented, referenceEnergy(f.timestamps, f.ys[1], f.ys[2], 3600000, 0, f.size - 1, segments));
  assert.notDeepStrictEqual(segmented, energy);
  for (const [a, b] of [
    [0, f.size - 1],
    [7, f.size - 2],
  ]) {
    assert.deepStrictEqual(
      calculateEnergyInRange(f.x, f.ys[1], f.ys[2], a, b),
      referenceEnergy(f.x, f.ys[1], f.ys[2], 3600, a, b),
    );
    assert.deepStrictEqual(
      calculateEnergyInRange(f.x, f.ys[1], f.ys[2], a, b, segments),
      referenceEnergy(f.x, f.ys[1], f.ys[2], 3600, a, b, segments),
    );
  }
  const edge = boundaryFixture();
  assert.deepStrictEqual(
    calculateEnergyInRange(edge.times, edge.current, edge.power, 0, 7),
    referenceEnergy(edge.times, edge.current, edge.power, 3600),
  );
  return {
    passed: true,
    equality: 'Object.is/deepStrictEqual; no tolerance',
    energy,
    boundaries: edge.labels,
    inputSha256: inputHash(f),
    segmentsSha256: sha256(canonicalBytes([segments])),
    f64CapacityBytes: copies.reduce((sum, c) => sum + c.byteLength, 0),
  };
}
function timed(name, fn, config, samples, repeat = 1) {
  for (let i = 0; i < config.warmup; i++) fn();
  const rssBefore = process.memoryUsage().rss,
    cpuBefore = process.cpuUsage();
  const durations = [];
  const blockDurations = [];
  let peakSampledRss = rssBefore;
  let sink;
  for (let i = 0; i < config.runs; i++) {
    const t = performance.now();
    for (let r = 0; r < repeat; r++) sink = fn();
    const block = performance.now() - t;
    blockDurations.push(block);
    durations.push(block / repeat);
    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
  }
  assert.ok(sink !== undefined);
  const stats = quantiles(durations);
  return {
    name,
    repeat,
    ms: stats,
    // --compare gates on this per-op figure, so it is only trustworthy when the block it
    // was divided out of sits well above the timer's resolution. projectBaseline enforces that.
    blockMs: quantiles(blockDurations),
    rawMs: durations,
    samplesPerSecondAtP50: samples / (stats.p50 / 1000),
    rssBefore,
    rssAfter: process.memoryUsage().rss,
    peakSampledRss,
    rssMethod: 'process.memoryUsage().rss sampled after each operation, not OS peak',
    cpuMicroseconds: process.cpuUsage(cpuBefore),
  };
}
function collectCase(config, n) {
  const f = fixture(n);
  const segments = segmentsFixture(n);
  const correctness = golden(f, segments);
  const b = new SeriesBuckets();
  b.rebuild(f.x, f.ys, 0, n, 1200);
  const metrics = [
    timed(
      'F64Col.push.8channels',
      () => {
        const cols = f.ys.map(() => new F64Col());
        for (let i = 0; i < n; i++) for (let s = 0; s < 8; s++) cols[s].push(f.ys[s][i]);
        return cols;
      },
      config,
      n,
    ),
    timed(
      'SeriesBuckets.rebuild.full',
      () => {
        b.rebuild(f.x, f.ys, 0, n, 1200);
        return b;
      },
      config,
      n,
    ),
    // One flatten is sub-microsecond even at 1M; 32768 of them put the block above the
    // timer at every gated size, which is what lets this op be gated at all instead of
    // reporting a bare 0 that someone will later use as a divisor.
    timed('SeriesBuckets.flatten.reused', () => b.flatten(), config, b.list.length * 2, 32768),
    // segments=null is what live capture pays (src/data.js accumulates inline instead),
    // and the segmented form is what a CSV import with a recordingSegments column pays.
    // calculateEnergy is correctness-checked in golden() but not timed: it has no
    // production caller, so gating it would lock a function nobody calls.
    timed(
      'integrateEnergy.nullSegments',
      () => calculateEnergyInRange(f.x, f.ys[1], f.ys[2], 7, n - 2, null),
      config,
      n - 8,
    ),
    timed(
      'integrateEnergy.withSegments',
      () => calculateEnergyInRange(f.x, f.ys[1], f.ys[2], 7, n - 2, segments),
      config,
      n - 8,
    ),
  ];
  return { size: n, correctness, metrics };
}

/** A single pass over the requested sizes; timings only mean something relative to another
 * pass taken minutes, not days, apart on the same host. */
function runPass(config) {
  return {
    config,
    fixture: {
      version: VERSION,
      seed: SEED,
      segments: SEGMENTS_VERSION,
      layout: 'x,timestamps,8 channels; little-endian f64; canonical NaN',
    },
    cases: config.sizes.map((n) => collectCase(config, n)),
  };
}
export async function main(argv = process.argv.slice(2)) {
  const config = options(argv, {
    sizes: SIZES,
    runs: 20,
    warmup: 5,
    // Odd, and for a reason: with two passes a single first-pass JIT outlier (measured:
    // nullSegments 1.42ms then 0.25ms in one process) becomes half of the median. Three
    // passes let mergeProjections pick a real middle value and make corroboration 3/3.
    passes: 3,
    baseline: false,
    compare: false,
    verifyBaseline: false,
    threshold: 1.15,
    output: 'bench/results/core.json',
    baselinePath: BASELINE_PATH,
  });
  const before = await provenance();
  const result = {
    schema: 'witrn-core-v1',
    layer: 'Node pure algorithms; NOT UI FPS',
    startedAt: new Date().toISOString(),
    environment: environment(),
    config,
    provenanceBefore: before,
    passes: [],
    limitations: [
      'No HID, native IPC, DOM, CSV app import/export, or GPU measurement',
      'No forced GC; RSS includes golden and previous cases; no per-operation memory attribution',
      'Golden checks preserve existing absolute-current right-endpoint integration semantics',
      'Absolute ms is machine-relative, so --compare never reads a raw ratio. Measured on',
      '  this host with UNCHANGED code: three back-to-back runs put every gated op at',
      '  1.12-1.50x while the host throttled, and one single-pass verdict came out at',
      '  adjusted x1.20 and did not repeat. So --compare divides each ratio by the smallest',
      '  ratio in the cohort (the machine state this run, since code can only add cost and',
      '  drift adds it everywhere) and requires every --passes pass to breach. Verified both',
      '  ways: unchanged code passes, and an injected 5x slowdown in integrateEnergy fails',
      '  3/3 passes. Residual blind spot: a change that slows every gated op by the SAME',
      '  factor normalizes to x1.00 here; that case needs the paired in-process git-revision',
      '  A/B (ci.yml) to be seen.',
    ],
  };
  for (let p = 0; p < config.passes; p++) {
    const pass = runPass(config);
    result.passes.push(pass);
    for (const c of pass.cases)
      console.error(
        JSON.stringify({
          pass: p,
          size: c.size,
          golden: 'passed',
          p50ms: Object.fromEntries(c.metrics.map((m) => [m.name, m.ms.p50])),
        }),
      );
  }
  result.provenanceAfter = await provenance();
  result.sourceStable = before.sourceSha256 === result.provenanceAfter.sourceSha256;
  result.finishedAt = new Date().toISOString();
  result.resourceUsage = process.resourceUsage();
  const path = await saveJson(config.output, result);
  console.log(JSON.stringify({ output: path, sourceStable: result.sourceStable }));
  if (!(config.baseline || config.compare || config.verifyBaseline)) return result;
  const projections = result.passes.map((pass) =>
    projectBaseline({ bench: 'core', pass, gated: GATED, provenanceCommit: before.commit }),
  );
  if (config.baseline) {
    const written = await saveJson(config.baselinePath, mergeProjections(projections));
    console.error(
      `基线已写入 ${written}（${projections.length} 轮取中位数，只含门禁指标；原始结果在 bench/results/，不入库）`,
    );
    return result;
  }
  const baseline = await readJson(config.baselinePath);
  if (config.verifyBaseline) {
    const { text, problems } = verifyBaseline(baseline, projections[0]);
    console.log(text);
    if (problems.length) process.exitCode = 1;
    return result;
  }
  const comparison = corroboration(baseline, projections, config.threshold);
  console.log(renderComparison(comparison).text);
  const driftLabel = 'x' + comparison.drift.toFixed(2);
  if (comparison.unconfirmed.length)
    console.log(`  未获 ${comparison.passes} 轮互证，仅报告：${comparison.unconfirmed.join('; ')}`);
  if (comparison.problems.length || comparison.failed.length) process.exitCode = 1;
  if (comparison.failed.length)
    console.log(
      `GATE FAILED: ${comparison.failed.length} 项在 ${comparison.passes} 轮中都扣除 ${driftLabel} 环境漂移后仍超过 x${config.threshold} —— ${comparison.failed.join(', ')}`,
    );
  else if (comparison.problems.length) console.log(`GATE FAILED: ${comparison.problems.length} 项使比较无效`);
  else
    console.log(
      `gate passed (可门禁 ${comparison.rows.filter((r) => r.gateable).length}/${comparison.rows.length}，${comparison.passes} 轮互证，漂移 ${driftLabel}，基线 ${config.baselinePath})`,
    );
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
