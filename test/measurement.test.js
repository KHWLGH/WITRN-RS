import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExportRows,
  calculateEnergy,
  calculateEnergyInRange,
  mapCsvColumns,
  parseRelativeTime,
} from '../src/measurement.js';

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

test('integrates only the selected index range in seconds', () => {
  // 4 个点、每段 1 小时（相对秒）
  const seconds = [0, 3600, 7200, 10800];
  const current = [2, 2, 2, 2];
  const power = [10, 10, 10, 10];

  const full = calculateEnergyInRange(seconds, current, power, 0, seconds.length - 1);
  assert.equal(full.wh, 30);
  assert.equal(full.mah, 6000);

  const middle = calculateEnergyInRange(seconds, current, power, 1, 2);
  assert.equal(middle.wh, 10);
  assert.equal(middle.mah, 2000);

  // 单点区间没有可积分的间隔
  const single = calculateEnergyInRange(seconds, current, power, 2, 2);
  assert.equal(single.wh, 0);
  assert.equal(single.mah, 0);

  // 越界的结束索引被夹到序列末尾
  const clamped = calculateEnergyInRange(seconds, current, power, 0, 99);
  assert.deepEqual(clamped, full);
});

test('builds export rows from the chart data source', () => {
  const cols = {
    timestamps: [1000, 2000],
    voltage: [5, 6],
    current: [1, 2],
    power: [5, 12],
    temp: [Number.NaN, 0],
    dp: [2.7, 0.6],
    dn: [2.7, Number.NaN],
    cc1: [1.7, 0],
    cc2: [0, 1.7],
    x: [0, 1],
  };
  const rows = buildExportRows(cols, cols);
  assert.deepEqual(rows, [
    { relSeconds: 0, voltage: 5, current: 1, power: 5, temp: Number.NaN, dp: 2.7, dn: 2.7, cc1: 1.7, cc2: 0 },
    { relSeconds: 1, voltage: 6, current: 2, power: 12, temp: 0, dp: 0.6, dn: Number.NaN, cc1: 0, cc2: 1.7 },
  ]);
});

test('maps optional CSV columns from legacy and current headers', () => {
  // 本应用旧格式（无信号线列）
  assert.deepEqual(mapCsvColumns('Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),'), {
    tempIdx: -1,
    dpIdx: -1,
    dnIdx: -1,
    cc1Idx: -1,
    cc2Idx: -1,
  });
  assert.deepEqual(mapCsvColumns('Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),'), {
    tempIdx: 4,
    dpIdx: -1,
    dnIdx: -1,
    cc1Idx: -1,
    cc2Idx: -1,
  });
  // 新格式（带信号线列，含/不含温度）
  assert.deepEqual(mapCsvColumns('Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),D+(V),D-(V),CC1(V),CC2(V),'), {
    tempIdx: -1,
    dpIdx: 4,
    dnIdx: 5,
    cc1Idx: 6,
    cc2Idx: 7,
  });
  assert.deepEqual(
    mapCsvColumns('Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),D+(V),D-(V),CC1(V),CC2(V),'),
    { tempIdx: 4, dpIdx: 5, dnIdx: 6, cc1Idx: 7, cc2Idx: 8 },
  );
});
