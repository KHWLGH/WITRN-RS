import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKET_MIN,
  bucketCap,
  firstIndexAfter,
  firstIndexAtOrAfter,
  nearestIndex,
  SeriesBuckets,
} from '../src/chart-buckets.js';

test('bucketCap is at least 64 and scales with width', () => {
  assert.equal(bucketCap(10), BUCKET_MIN);
  assert.equal(bucketCap(400), 800);
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

test('covers reports whether a rebuilt window contains a range', () => {
  const buckets = new SeriesBuckets();
  assert.equal(buckets.covers(0, 0), true);
  assert.equal(buckets.covers(0, 1), false);

  const xs = Float64Array.from({ length: 20 }, (_, i) => i);
  const ys = Float64Array.from({ length: 20 }, (_, i) => i);
  buckets.rebuild(xs, channels(xs, ys), 4, 16, 32);
  assert.equal(buckets.covers(4, 16), true);
  assert.equal(buckets.covers(6, 12), true);
  assert.equal(buckets.covers(0, 16), false);
  assert.equal(buckets.covers(4, 20), false);
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
  assert.equal(buckets.ppb, Math.ceil(800 / 64));

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
