import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateEnergy,
  calculateEnergyInRange,
  mapCsvColumns,
  nextRecordingX,
  niceCeiling,
  parseRelativeTime,
} from '../src/measurement.js';

test('parses day-prefixed and fractional relative times', () => {
  assert.equal(parseRelativeTime('0.01:02:03.500'), 3723.5);
  assert.equal(parseRelativeTime('01:02:03.5'), 3723.5);
  assert.equal(parseRelativeTime('1.00:00:00.000'), 86400);
  assert.equal(parseRelativeTime('not-a-time'), null);
});

test('nextRecordingX clamps backward and sleep-sized jumps', () => {
  assert.equal(nextRecordingX(1, 0.5, 250), 1.25);
  assert.ok(nextRecordingX(1, 3601, 250) - 1 < 1);
  assert.equal(nextRecordingX(1, 1.2, 250), 1.2);
});

test('integrates only adjacent measurement intervals', () => {
  const timestamps = [0, 1000, 2000];
  const result = calculateEnergy(timestamps, [2, 2, 2], [10, 10, 10]);
  assert.equal(result.wh, 20 / 3600);
  assert.equal(result.mah, 4000 / 3600);

  const withReverseInterval = calculateEnergy([0, 1000, 500, 1500], [2, 2, 2, 2], [10, 10, 10, 10]);
  assert.equal(withReverseInterval.wh, 20 / 3600);
  assert.equal(withReverseInterval.mah, 4000 / 3600);
});

test('integrates only the selected index range in seconds', () => {
  // 4 个点、每段 1 秒（相对秒）
  const seconds = [0, 1, 2, 3];
  const current = [2, 2, 2, 2];
  const power = [10, 10, 10, 10];

  const full = calculateEnergyInRange(seconds, current, power, 0, seconds.length - 1);
  assert.equal(full.wh, 30 / 3600);
  assert.equal(full.mah, 6000 / 3600);

  const middle = calculateEnergyInRange(seconds, current, power, 1, 2);
  assert.equal(middle.wh, 10 / 3600);
  assert.equal(middle.mah, 2000 / 3600);

  // 单点区间没有可积分的间隔
  const single = calculateEnergyInRange(seconds, current, power, 2, 2);
  assert.equal(single.wh, 0);
  assert.equal(single.mah, 0);

  // 越界的结束索引被夹到序列末尾
  const clamped = calculateEnergyInRange(seconds, current, power, 0, 99);
  assert.deepEqual(clamped, full);
});

test('skips energy intervals larger than one sample gap', () => {
  const seconds = [0, 1, 10];
  const current = [2, 2, 2];
  const power = [10, 10, 10];
  const result = calculateEnergyInRange(seconds, current, power, 0, seconds.length - 1);
  assert.equal(result.wh, 10 / 3600);
  assert.equal(result.mah, (2 * 1000) / 3600);
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

test('niceCeiling snaps to the 1-2-5 series', () => {
  assert.equal(niceCeiling(12.3), 20);
  assert.equal(niceCeiling(3.4), 5);
  assert.equal(niceCeiling(31), 50);
  assert.equal(niceCeiling(1), 1);
  assert.equal(niceCeiling(2), 2);
  assert.equal(niceCeiling(5), 5);
  assert.equal(niceCeiling(5.1), 10);
  assert.equal(niceCeiling(100), 100);
  assert.equal(niceCeiling(0.3), 0.5);
  assert.equal(niceCeiling(0), 1);
  assert.equal(niceCeiling(-8), 1);
  assert.equal(niceCeiling(Number.NaN), 1);
  assert.equal(niceCeiling(Number.POSITIVE_INFINITY), 1);
});
