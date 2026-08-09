import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExportRows, calculateEnergy, parseRelativeTime } from '../src/measurement.js';

test('parses day-prefixed and fractional relative times', () => {
  assert.equal(parseRelativeTime('0.01:02:03.500'), 3723.5);
  assert.equal(parseRelativeTime('01:02:03.5'), 3723.5);
  assert.equal(parseRelativeTime('not-a-time'), null);
});

test('integrates only adjacent measurement intervals', () => {
  const timestamps = [0, 3600000, 7200000];
  const result = calculateEnergy(timestamps, [2, 2, 2], [10, 10, 10]);
  assert.equal(result.wh, 20);
  assert.equal(result.mah, 4000);

  const withReverseInterval = calculateEnergy([0, 3600000, 1800000, 5400000], [2, 2, 2, 2], [10, 10, 10, 10]);
  assert.equal(withReverseInterval.wh, 20);
  assert.equal(withReverseInterval.mah, 4000);
});

test('builds export rows from the chart data source', () => {
  const rows = buildExportRows(
    { timestamps: [1000, 2000], voltage: [5, 6], current: [1, 2], power: [5, 12], temp: [Number.NaN, 0] },
    { x: [0, 1] },
  );
  assert.deepEqual(rows, [
    { relSeconds: 0, voltage: 5, current: 1, power: 5, temp: Number.NaN },
    { relSeconds: 1, voltage: 6, current: 2, power: 12, temp: 0 },
  ]);
});
