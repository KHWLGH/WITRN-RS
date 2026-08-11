import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSampleRateLabel } from '../src/utils.js';

test('formats sub-second sampling intervals as a plain rate', () => {
  assert.equal(formatSampleRateLabel(10), '100 次/秒');
  assert.equal(formatSampleRateLabel(100), '10 次/秒');
  assert.equal(formatSampleRateLabel(250), '4 次/秒');
  assert.equal(formatSampleRateLabel(1000), '1 次/秒');
});

test('formats multi-second intervals with a period suffix', () => {
  assert.equal(formatSampleRateLabel(5000), '0.2 次/秒 (5秒1次)');
  assert.equal(formatSampleRateLabel(10000), '0.1 次/秒 (10秒1次)');
  assert.equal(formatSampleRateLabel(1500), '0.67 次/秒 (1.5秒1次)');
});

test('rounds rates that do not divide evenly', () => {
  // CSV 导入会带进任意间隔，不能假设能整除。
  assert.equal(formatSampleRateLabel(333), '3 次/秒');
  assert.equal(formatSampleRateLabel(60_000), '0.02 次/秒 (60秒1次)');
});
