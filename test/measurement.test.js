import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateEnergy,
  calculateEnergyInRange,
  energyMaxStepS,
  estimateIntervalMsFromX,
  isRecordingBoundary,
  mapCsvColumns,
  nextRecordingX,
  niceCeiling,
  parseRelativeTime,
} from '../src/measurement.js';
import { F64Col } from '../src/state.js';

/** An independent re-implementation of the segmented integration rule, written the obvious
 * way (call the exported helper per point). src/measurement.js inlines nothing today, but this
 * stays as the oracle so any future hoist of that guard has something to be checked against. */
function energyViaHelper(times, current, power, perHour, start, end, segments, maxStepS = 2) {
  let wh = 0;
  let mah = 0;
  for (let i = Math.max(0, start) + 1; i <= Math.min(end, times.length - 1); i++) {
    if (isRecordingBoundary(segments, i)) continue;
    const dt = (times[i] - times[i - 1]) / perHour;
    const amps = Math.abs(current[i]);
    const watts = Math.abs(power[i]);
    if (dt < 0 || !Number.isFinite(dt) || !Number.isFinite(amps) || !Number.isFinite(watts)) continue;
    if (dt * 3600 > maxStepS) continue;
    wh += watts * dt;
    mah += amps * 1000 * dt;
  }
  return { wh, mah };
}

/** 积分顺序不同会带来 1e-17 级的结合律差异，这里只判语义不判浮点顺序。 */
function assertClose(actual, expected, epsilon = 1e-15, message) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message ?? ''} actual=${actual} expected=${expected}`);
}

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

// ─── 空档阈值必须随标称采样间隔定标 ─────────────────────────────────────────
// x 轴侧 nextRecordingX 早已按 max(间隔×8, 2s) 放行，积分侧若仍用绝对 2 秒，
// 5s / 10s 档下每个真实采样步长都会被当成空档丢掉，能量恒为 0。

test('energyMaxStepS scales with the sample interval but never drops the 2s floor', () => {
  assert.equal(energyMaxStepS(10), 2);
  assert.equal(energyMaxStepS(250), 2);
  assert.equal(energyMaxStepS(500), 4);
  assert.equal(energyMaxStepS(1000), 8);
  assert.equal(energyMaxStepS(5000), 40);
  assert.equal(energyMaxStepS(60000), 480);
  // 未知/非法间隔必须回落到今天的行为，不能把守卫整个关掉
  assert.equal(energyMaxStepS(null), 2);
  assert.equal(energyMaxStepS(Number.NaN), 2);
  assert.equal(energyMaxStepS(0), 2);
  assert.equal(energyMaxStepS(-5000), 2);
  assert.equal(energyMaxStepS('abc'), 2);
});

test('a 5s preset integrates its own cadence', () => {
  const seconds = [0, 5, 10];
  const current = [2, 2, 2];
  const power = [10, 10, 10];
  const scaled = calculateEnergyInRange(seconds, current, power, 0, 2, null, 5000);
  assertClose(scaled.wh, 2 * ((10 * 5) / 3600));
  assertClose(scaled.mah, 2 * ((2 * 1000 * 5) / 3600));
  // 非空断言：阈值是移动了，不是守卫消失了
  assert.equal(calculateEnergyInRange(seconds, current, power, 0, 2).wh, 0);
});

test('a sleep-sized hole is still skipped at a slow preset', () => {
  const seconds = [0, 5, 10, 1810, 1815];
  const current = [2, 2, 2, 2, 2];
  const power = [10, 10, 10, 10, 10];
  const result = calculateEnergyInRange(seconds, current, power, 0, 4, null, 5000);
  assertClose(result.wh, 3 * ((10 * 5) / 3600), 1e-12, '三个 5 秒步进可积，1800 秒空档不可积');
});

test('estimateIntervalMsFromX reads the nominal cadence back from relative x', () => {
  assert.equal(estimateIntervalMsFromX([0, 5, 10, 15, 20]), 5000);
  assert.equal(estimateIntervalMsFromX([0, 5, 10, 1810, 1815]), 5000);
  assert.equal(estimateIntervalMsFromX([0, 0.25, 0.5]), 250);
  assert.equal(estimateIntervalMsFromX([0, 1]), 1000);
  assert.equal(estimateIntervalMsFromX([7]), null);
  assert.equal(estimateIntervalMsFromX([]), null);
  assert.equal(estimateIntervalMsFromX([0, Number.NaN, 5, 10]), 5000);
  // 越界的估计值夹到命令的实际接受域，不能给出一个设备不可能的间隔
  assert.equal(estimateIntervalMsFromX([0, 500, 1000]), 60000);
  assert.equal(estimateIntervalMsFromX([0, 0.001, 0.002]), 1);
});

test('the interval-aware guard still agrees with the obvious helper', () => {
  const times = [0, 5, 10, 40, 1840, 1845];
  const current = [1, -2, 3, NaN, 5, 6];
  const power = [10, 20, 30, 40, 50, NaN];
  assert.deepEqual(
    calculateEnergyInRange(times, current, power, 0, times.length - 1, null, 5000),
    energyViaHelper(times, current, power, 3600, 0, times.length - 1, null, energyMaxStepS(5000)),
  );
  assert.deepEqual(
    calculateEnergy(times, current, power, null, 5000),
    energyViaHelper(times, current, power, 3600000, 0, times.length - 1, null, energyMaxStepS(5000)),
  );
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

test('a recording boundary drops only the interval that crosses it', () => {
  const seconds = [0, 1, 2, 3, 4];
  const current = [2, 2, 2, 2, 2];
  const power = [10, 10, 10, 10, 10];

  // 无分段：4 个间隔全部积分。
  assert.deepEqual(calculateEnergyInRange(seconds, current, power, 0, 4), { wh: 40 / 3600, mah: 8000 / 3600 });
  // i=2 换段：只丢 i=1→2 这一个间隔。
  assert.deepEqual(calculateEnergyInRange(seconds, current, power, 0, 4, [0, 0, 1, 1, 1]), {
    wh: 30 / 3600,
    mah: 6000 / 3600,
  });
  // 连续两次换段丢两个间隔。
  assert.deepEqual(calculateEnergyInRange(seconds, current, power, 0, 4, [0, 1, 2, 3, 4]), { wh: 0, mah: 0 });
});

test('a NaN segment id is not a boundary', () => {
  // src/data.js:608 依赖这个语义：尾部用 NaN 填充"从未录制"的点，
  // 那些点之间仍然要能积分，否则增量区间统计会凭空少掉一段。
  const seconds = [0, 1, 2, 3];
  const result = calculateEnergyInRange(seconds, [2, 2, 2, 2], [10, 10, 10, 10], 0, 3, [0, NaN, NaN, 0]);
  // i=1: segments[1] 非有限 → 不是边界，积分；i=2 同理；i=3: 0 !== NaN → 是边界，丢弃。
  assert.deepEqual(result, { wh: 20 / 3600, mah: 4000 / 3600 });
});

test('omitting segments and passing null are the same', () => {
  const seconds = [0, 1, 2];
  const current = [1, 2, 3];
  const power = [10, 20, 30];
  assert.deepEqual(
    calculateEnergyInRange(seconds, current, power, 0, 2),
    calculateEnergyInRange(seconds, current, power, 0, 2, null),
  );
  assert.deepEqual(calculateEnergy(seconds, current, power), calculateEnergy(seconds, current, power, null));
  assert.deepEqual(
    calculateEnergy(seconds, current, power, null),
    energyViaHelper(seconds, current, power, 3600000, 0, 2, null),
  );
});

test('integrateEnergy agrees with the obvious per-point helper over many segment shapes', () => {
  // 覆盖 null / 全同段 / 每点换段 / NaN 空洞 / 越界索引 五种形状。
  const shapes = [
    null,
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 2, 3, 4, 5, 6, 7],
    [0, 0, NaN, NaN, 4, 4, 4, NaN],
    [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN],
    [3, 3, 3, -1, -1, 0, 0, 0],
  ];
  for (const segments of shapes) {
    // 用非平凡的时间/幅值，让 dt 守卫与 NaN 守卫也参与比较。
    const times = [0, 0.5, 1.5, 2.0, 2.0, 5.0, 5.5, 6.0];
    const current = [1, -2, 3, NaN, 5, 6, -7, 8];
    const power = [10, 20, 30, 40, 50, NaN, 70, 80];
    assert.deepEqual(
      calculateEnergy(times, current, power, segments),
      energyViaHelper(times, current, power, 3600000, 0, times.length - 1, segments),
      `segments=${JSON.stringify(segments && [...segments])}`,
    );
    for (const [start, end] of [
      [0, 2],
      [3, 7],
      [2, 5],
      [-4, 99],
      [5, 5],
    ])
      assert.deepEqual(
        calculateEnergyInRange(times, current, power, start, end, segments),
        energyViaHelper(times, current, power, 3600, start, end, segments),
      );
  }
});

test('chunked columns preserve energy and interval results across chunk boundaries', () => {
  const n = 9001;
  const times = Float64Array.from({ length: n }, (_, i) => i * 0.25);
  const current = Float64Array.from({ length: n }, (_, i) => (i % 17 ? 2 : -3));
  const power = Float64Array.from({ length: n }, (_, i) => (i % 19 ? 10 : Number.NaN));
  const segments = Float64Array.from({ length: n }, (_, i) => Math.floor(i / 4096));
  segments[8189] = Number.NaN;
  times[8192] += 100;
  const columns = [times, current, power, segments].map((values) => {
    const column = new F64Col();
    column.set(values);
    return column;
  });
  for (const [start, end] of [
    [0, n - 1],
    [4094, 4098],
    [8188, 8194],
  ]) {
    assert.deepEqual(
      calculateEnergyInRange(columns[0], columns[1], columns[2], start, end, columns[3], 250),
      calculateEnergyInRange(times, current, power, start, end, segments, 250),
    );
  }
  assert.equal(estimateIntervalMsFromX(columns[0]), estimateIntervalMsFromX(times));
});
