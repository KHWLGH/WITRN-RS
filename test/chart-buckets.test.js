import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKET_MIN,
  bucketCap,
  firstIndexAfter,
  firstIndexAtOrAfter,
  nearestIndex,
  SeriesBuckets,
  stripePpb,
} from '../src/chart-buckets.js';

test('bucketCap is at least 64 and scales with width', () => {
  assert.equal(bucketCap(10), BUCKET_MIN);
  assert.equal(bucketCap(400), 400);
});

test('nearestIndex finds the closest sample', () => {
  const xs = [0, 1, 2, 3, 4];
  assert.equal(nearestIndex(xs, 5, -1), 0);
  assert.equal(nearestIndex(xs, 5, 4.9), 4);
  assert.equal(nearestIndex(xs, 5, 1.4), 1);
  assert.equal(nearestIndex(xs, 5, 1.6), 2);
});

test('window index helpers slice an inclusive-exclusive range', () => {
  const xs = [0, 10, 20, 30];
  assert.equal(firstIndexAtOrAfter(xs, 4, 10), 1);
  assert.equal(firstIndexAtOrAfter(xs, 4, 11), 2);
  assert.equal(firstIndexAfter(xs, 4, 20), 3);
  assert.equal(firstIndexAfter(xs, 4, 30), 4);
});

function channels(_xs, ys) {
  const rest = Array.from({ length: 7 }, () => ys);
  return [ys, ...rest];
}

test('once ppb > 1, new samples fold into the last bucket', () => {
  const buckets = new SeriesBuckets();
  buckets.cap = 2;
  const zeros = new Array(8).fill(0);
  buckets.pushSample(0, zeros);
  buckets.pushSample(1, zeros);
  buckets.pushSample(2, zeros);
  const n = buckets.list.length;
  const lastN = buckets.list[n - 1].n;
  buckets.pushSample(3, [5, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(buckets.list.length, n);
  assert.equal(buckets.list[n - 1].n, lastN + 1);
  assert.equal(buckets.list[n - 1].min[0], 0);
  assert.equal(buckets.list[n - 1].max[0], 5);
  assert.equal(buckets.srcEnd, 4);
});

test('overflowing the cap pairwise-merges and doubles ppb', () => {
  const buckets = new SeriesBuckets();
  buckets.cap = 4;
  const zeros = new Array(8).fill(0);
  for (let i = 0; i < 5; i++) buckets.pushSample(i, zeros);
  assert.ok(buckets.list.length <= 4);
  assert.equal(buckets.ppb, 2);
  assert.equal(buckets.srcEnd, 5);
});

test('rebuild then appendThrough only folds new tail samples', () => {
  const xs = Float64Array.from({ length: 20 }, (_, i) => i);
  const ys = Float64Array.from({ length: 20 }, (_, i) => i);
  const series = channels(xs, ys);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, series, 0, 10, 32);
  assert.equal(buckets.srcStart, 0);
  assert.equal(buckets.srcEnd, 10);
  const before = buckets.list.length;
  assert.equal(buckets.canAppend(0, 20), true);
  buckets.appendThrough(xs, series, 20);
  assert.equal(buckets.srcEnd, 20);
  assert.ok(buckets.list.length >= before);
});

test('fixed-density append preserves an existing projection until an explicit rebuild', () => {
  const n = 4096;
  const xs = Float64Array.from({ length: n }, (_, i) => i);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, channels(xs, xs), 0, 1024, 64);
  const ppb = buckets.ppb;
  buckets.appendThroughFixed(xs, channels(xs, xs), n);
  assert.equal(buckets.ppb, ppb);
  assert.equal(buckets.srcEnd, n);
  assert.ok(buckets.list.length <= Math.ceil(n / ppb));
});

test('fixed-density append has the same buckets as a rebuild while the target density is stable', () => {
  const end = 1200;
  const split = 1000;
  const xs = Float64Array.from({ length: end }, (_, i) => i * 0.001);
  const series = channels(
    xs,
    Float64Array.from({ length: end }, (_, i) => Math.sin(i / 11)),
  );
  const actual = new SeriesBuckets();
  actual.rebuild(xs, series, 0, split, 64);
  const ppb = actual.ppb;
  actual.appendThroughFixed(xs, series, end);

  const expected = new SeriesBuckets();
  expected.rebuild(xs, series, 0, end, Math.ceil(end / ppb));
  assert.equal(expected.ppb, ppb);
  assert.deepEqual(actual.list, expected.list);
});

test('fixed-density append exposes capacity exhaustion for an explicit rebuild', () => {
  const end = 2049;
  const xs = Float64Array.from({ length: end }, (_, i) => i);
  const series = channels(
    xs,
    Float64Array.from({ length: end }, (_, i) => i % 37),
  );
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, series, 0, 1024, 64);
  const stablePpb = buckets.ppb;
  const headroomCap = buckets.cap;
  buckets.appendThroughFixed(xs, series, end);
  assert.equal(buckets.ppb, stablePpb);
  assert.ok(buckets.list.length > headroomCap);

  buckets.rebuild(xs, series, 0, end, 64);
  assert.ok(buckets.list.length <= 64);
  assert.ok(buckets.ppb > stablePpb);
});

test('stripePpb is the density both rebuild and the reuse check agree on', () => {
  assert.equal(stripePpb(1, 64), 1);
  assert.equal(stripePpb(1000, 64), 16);
  assert.equal(stripePpb(1024, 64), 16);
  assert.equal(stripePpb(1025, 64), 32);
  assert.equal(stripePpb(2048, 64), 32);
  // cap 低于 BUCKET_MIN 时按 64 算；调用方若自己算一遍就会与桶内实际密度不一致。
  assert.equal(stripePpb(1000, 8), stripePpb(1000, BUCKET_MIN));

  const n = 1000;
  const xs = Float64Array.from({ length: n }, (_, i) => i);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, channels(xs, xs), 0, n, 8);
  assert.equal(buckets.ppb, stripePpb(n, 8));
});

test('a growing 1KSPS history changes projection density only logarithmically', () => {
  const cap = 800;
  const seconds = 600;
  let rebuilds = 0;
  let previous = stripePpb(cap + 1, cap);
  for (let points = cap + 2; points <= seconds * 1000; points += 20) {
    const next = stripePpb(points, cap);
    if (next !== previous) {
      assert.equal(next, previous * 2);
      previous = next;
      rebuilds++;
    }
  }
  assert.ok(rebuilds <= Math.ceil(Math.log2((seconds * 1000) / cap)));
});

test('rebuild leaves merge headroom so an appended sample cannot halve resolution', () => {
  // 条带数正好等于 cap 的窗口：旧实现里 cap 原样留着，落一个样本就 mergeDown，
  // 画面会在没人操作时自己变稀一档。
  const n = 128 * 64;
  const xs = Float64Array.from({ length: n }, (_, i) => i);
  const ys = Float64Array.from({ length: n }, (_, i) => i);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, channels(xs, ys), 0, n, 64);
  assert.equal(buckets.list.length, 64);
  const ppb = buckets.ppb;
  const zeros = new Array(8).fill(0);
  buckets.pushSample(n, zeros);
  buckets.pushSample(n + 1, zeros);
  assert.equal(buckets.ppb, ppb, '追加样本不得改变条带宽度');
  // 第二个样本折进新建的半空桶，所以只多出一个桶，而不是整表腰斩成 33。
  assert.equal(buckets.list.length, 65);
});

test('rebuild folds a window in one pass and stays within cap', () => {
  const n = 1000;
  const xs = Float64Array.from({ length: n }, (_, i) => i);
  const ys = Float64Array.from({ length: n }, (_, i) => i * 2);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, channels(xs, ys), 100, 900, 64);
  assert.equal(buckets.srcStart, 100);
  assert.equal(buckets.srcEnd, 900);
  assert.ok(buckets.list.length <= 64);
  assert.ok(buckets.list.length > 0);
  assert.equal(buckets.ppb, stripePpb(800, 64));

  let min = Infinity;
  let max = -Infinity;
  let counted = 0;
  for (const b of buckets.list) {
    min = Math.min(min, b.min[0]);
    max = Math.max(max, b.max[0]);
    counted += b.n;
  }
  assert.equal(counted, 800);
  assert.equal(min, 200);
  assert.equal(max, 1798);
});

test('rebuild of a large window does not exceed cap', () => {
  const n = 20000;
  const xs = Float64Array.from({ length: n }, (_, i) => i);
  const ys = Float64Array.from({ length: n }, (_, i) => (i % 17) - 8);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, channels(xs, ys), 0, n, 128);
  assert.ok(buckets.list.length <= 128);
  assert.equal(buckets.srcEnd, n);
  let min = Infinity;
  let max = -Infinity;
  for (const b of buckets.list) {
    min = Math.min(min, b.min[0]);
    max = Math.max(max, b.max[0]);
  }
  assert.equal(min, -8);
  assert.equal(max, 8);
});

test('flatten emits two vertices per bucket at the midpoint', () => {
  const buckets = new SeriesBuckets();
  buckets.cap = 64;
  buckets.ppb = 2;
  buckets.pushSample(0, [1, 0, 0, 0, 0, 0, 0, 0]);
  buckets.pushSample(2, [3, 0, 0, 0, 0, 0, 0, 0]);
  const flat = buckets.flatten();
  assert.equal(flat.x.length, 2);
  assert.equal(flat.x[0], 1);
  assert.equal(flat.x[1], 1);
  assert.equal(flat.ys[0][0], 1);
  assert.equal(flat.ys[0][1], 3);
});

test('coarsening and appending equal raw reconstruction, including signed zero, gaps and partial tails', () => {
  const n = 8201;
  const xs = Float64Array.from({ length: n }, (_, i) => Math.floor(i / 2) / 1000);
  const ys = Array.from({ length: 8 }, (_, s) =>
    Float64Array.from(xs, (_, i) =>
      s === 7 ? (i % 2 ? 0 : -0) : i % 19 === 0 ? NaN : i % 23 === 0 ? Infinity : (i % 71) - s,
    ),
  );
  for (const start of [0, 17]) {
    const actual = new SeriesBuckets();
    actual.rebuild(xs, ys, start, 4099, 512);
    actual.flatten();
    for (const [end, cap] of [
      [4103, 256],
      [n, 128],
      [n, 64],
    ]) {
      actual.coarsenTo(stripePpb(end - start, cap));
      actual.appendThroughFixed(xs, ys, end);
      const expected = new SeriesBuckets();
      expected.rebuild(xs, ys, start, end, cap);
      assert.deepEqual(actual.list, expected.list);
      assert.deepEqual(actual.flatten(), expected.flatten());
      assert.equal(actual.srcStart, start);
      assert.equal(actual.srcEnd, end);
    }
  }
});

test('coarsening rejects finer and non-power-of-two densities without changing the projection', () => {
  const xs = Float64Array.from({ length: 1000 }, (_, i) => i);
  const buckets = new SeriesBuckets();
  buckets.rebuild(xs, channels(xs, xs), 0, 1000, 64);
  const before = structuredClone(buckets.list);
  for (const ppb of [buckets.ppb / 2, buckets.ppb * 3, Infinity, NaN]) {
    assert.throws(() => buckets.coarsenTo(ppb), RangeError);
    assert.deepEqual(buckets.list, before);
  }
});
