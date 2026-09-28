import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BYTES_PER_POINT,
  clampLimitMb,
  DEFAULT_LIMIT_MB,
  describeLimit,
  formatDuration,
  formatPoints,
  pointsForLimit,
  remainingInfo,
} from '../src/recording-limit.js';

test('the limit is clamped to whole megabytes between 64 and 8192', () => {
  assert.equal(clampLimitMb(512), 512);
  assert.equal(clampLimitMb('1024'), 1024);
  assert.equal(clampLimitMb(10), 64);
  assert.equal(clampLimitMb(1e9), 8192);
  assert.equal(clampLimitMb(700.4), 700);
  for (const bad of [undefined, null, '', 'abc', Number.NaN]) assert.equal(clampLimitMb(bad), DEFAULT_LIMIT_MB);
});

test('megabytes become points at 100 bytes per point', () => {
  assert.equal(BYTES_PER_POINT, 100);
  assert.equal(pointsForLimit(512), Math.floor((512 * 1024 * 1024) / 100));
  assert.equal(pointsForLimit(1), pointsForLimit(64), 'the minimum applies before converting');
});

test('durations read as the largest two units', () => {
  assert.equal(formatDuration(0), '0 秒');
  assert.equal(formatDuration(59.9), '59 秒');
  assert.equal(formatDuration(125), '2 分 5 秒');
  assert.equal(formatDuration(7980), '2 小时 13 分');
  assert.equal(formatDuration(7200), '2 小时');
  assert.equal(formatDuration(3 * 86400 + 4 * 3600 + 59), '3 天 4 小时');
  assert.equal(formatDuration(Number.NaN), '0 秒');
});

test('point counts switch to 万 above ten thousand', () => {
  assert.equal(formatPoints(8400), '8,400 点');
  assert.equal(formatPoints(12_345), '1.2 万点');
  assert.equal(formatPoints(5_368_709), '537 万点');
});

test('the settings hint states points, duration at the current rate and CSV size', () => {
  const hint = describeLimit(512, 1);
  assert.match(hint, /^约 537 万点；按当前 1000 次\/秒 约可记录 1 小时 29 分，落盘 CSV 约 614 MB。$/);
  assert.match(describeLimit(512, 250), /4 次\/秒 约可记录 15 天 12 小时/);
  assert.match(describeLimit(512, 5000), /5 秒 1 次/);
});

test('remaining capacity warns below ten percent and reports full', () => {
  const limit = pointsForLimit(64);
  const fresh = remainingInfo(0, limit, 10);
  assert.equal(fresh.fraction, 1);
  assert.equal(fresh.warn, false);
  assert.match(fresh.text, /^100% · 约 /);
  const low = remainingInfo(Math.ceil(limit * 0.95), limit, 10);
  assert.equal(low.warn, true);
  assert.match(low.text, /^4% · 约 /);
  const full = remainingInfo(limit + 5, limit, 10);
  assert.equal(full.full, true);
  assert.equal(full.remaining, 0);
  assert.equal(full.text, '已满');
  assert.match(full.title, /^已用 .* \/ 上限 /);
});
