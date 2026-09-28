import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../src/csv-codec.js';
import { computeCsvImport } from '../src/csv-import-core.js';
import { calculateEnergyInRange } from '../src/measurement.js';
import { emptyChartColumns } from '../src/state.js';

const options = { signedCurrent: true, fallbackStartTime: 1234 };
const text =
  'SampTime(ms),5000\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),RelativeTime(s),Timestamp(ms),RecordingSegment\n00:00:10,Infinity,NaN,18,,10,10000,2\n00:00:00,-0,-0,10,25,0,0,1\n00:00:05,6,-3,18,Infinity,5,5000,1\n00:00:05,7,2,14,26,5,5000,1';

test('import computation retains stable exact columns and matches energy/stat semantics', () => {
  const result = computeCsvImport(text, options);
  const parsed = parseCsv(text, options);
  for (const key of Object.keys(parsed.columns)) {
    assert.deepEqual(result.columns[key].view(), parsed.columns[key].view(), key);
  }
  assert.ok(Object.is(result.columns.voltage.buf[0], -0));
  assert.deepEqual([...result.columns.voltage.view()], [-0, 6, 7, Infinity]);
  assert.deepEqual(result.stats.voltage, { min: -0, max: 7, sum: 13, count: 3 });
  assert.deepEqual(result.stats.temp, { min: 25, max: 26, sum: 51, count: 2 });
  assert.equal(result.hasTempData, true);
  assert.deepEqual(
    result.energy,
    calculateEnergyInRange(
      parsed.columns.x.view(),
      parsed.columns.current.view(),
      parsed.columns.power.view(),
      0,
      3,
      parsed.columns.recordingSegments.view(),
      parsed.intervalMs,
    ),
  );
});

test('only newly imported buffers are detached when transferring results', () => {
  const live = emptyChartColumns();
  live.voltage.push(123);
  const liveBuffer = live.voltage.buf.buffer;
  const result = computeCsvImport(text, options);
  const buffers = Object.values(result.columns).flatMap((column) => column._chunks.map((chunk) => chunk.buffer));
  const received = structuredClone(result, { transfer: buffers });
  assert.ok(buffers.every((buffer) => buffer.byteLength === 0));
  assert.ok(liveBuffer.byteLength > 0);
  assert.equal(live.voltage.at(0), 123);
  assert.deepEqual([...received.columns.current._chunks[0].subarray(0, 4)], [-0, -3, 2, NaN]);
});

test('invalid file never returns partial computation', () => {
  assert.throws(() => computeCsvImport('invalid', options), /Header not found/);
});
