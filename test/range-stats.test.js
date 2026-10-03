import assert from 'node:assert/strict';
import test from 'node:test';
import { ModuleWorker } from '../bench/module-worker.mjs';
import { isRecordingBoundary } from '../src/measurement.js';
import {
  captureRangeStatsSnapshot,
  computeRangeStatsAsync,
  computeRangeStatsSync,
  rangeStatsRevision,
} from '../src/range-stats.js';
import { computeRangeStatsBackground } from '../src/range-stats-background.js';
import { emptyChartColumns } from '../src/state.js';

function columnsOf(count, capacity = count) {
  const cols = emptyChartColumns(capacity);
  const values = [1e16, -1e16, 0.1, -0, 0, Number.NaN, Infinity, -Infinity, -7.3, 5.7];
  const arrays = Object.fromEntries(Object.keys(cols).map((key) => [key, new Float64Array(count)]));
  for (let i = 0; i < count; i++) {
    arrays.x[i] = i * 0.001;
    arrays.voltage[i] = values[i % values.length];
    arrays.current[i] = values[(i + 3) % values.length];
    arrays.power[i] = values[(i + 7) % values.length];
    arrays.temp[i] = values[(i + 1) % values.length];
    arrays.recordingSegments[i] = Math.floor(i / 13);
  }
  for (const [key, array] of Object.entries(arrays)) cols[key].set(array);
  return cols;
}

// The former data.js fold is kept as an independent arithmetic oracle.
function reference(snapshot) {
  const out = { wh: 0, mah: 0 };
  for (const suffix of ['V', 'C', 'P', 'T']) {
    out[`min${suffix}`] = Infinity;
    out[`max${suffix}`] = -Infinity;
    out[`sum${suffix}`] = 0;
    out[`count${suffix}`] = 0;
  }
  for (let i = snapshot.startIndex; i <= snapshot.endIndex; i++) {
    const v = snapshot.voltage.valueAt(i);
    const c = snapshot.current.valueAt(i);
    const p = snapshot.power.valueAt(i);
    const t = snapshot.temp.valueAt(i);
    for (const [suffix, value] of [
      ['V', v],
      ['C', c],
      ['P', p],
      ['T', t],
    ]) {
      if (!Number.isFinite(value)) continue;
      if (value < out[`min${suffix}`]) out[`min${suffix}`] = value;
      if (value > out[`max${suffix}`]) out[`max${suffix}`] = value;
      out[`sum${suffix}`] += value;
      out[`count${suffix}`] += 1;
    }
    if (i <= snapshot.startIndex || isRecordingBoundary(snapshot.recordingSegments, i)) continue;
    const dt = (snapshot.x.valueAt(i) - snapshot.x.valueAt(i - 1)) / 3600;
    const currentAbs = Math.abs(c);
    const powerAbs = Math.abs(p);
    const interval = snapshot.sampleIntervals.valueAt(i);
    const maxStepS = Number.isFinite(interval) && interval > 0 ? Math.max(2, (interval * 8) / 1000) : snapshot.maxStepS;
    if (
      dt < 0 ||
      dt > maxStepS / 3600 ||
      !Number.isFinite(dt) ||
      !Number.isFinite(currentAbs) ||
      !Number.isFinite(powerAbs)
    )
      continue;
    out.wh += powerAbs * dt;
    out.mah += currentAbs * 1000 * dt;
  }
  return out;
}

function assertExact(result, expected) {
  assert.ok(result);
  for (const key of Object.keys(expected)) {
    assert.ok(Object.is(result[key], expected[key]), `${key}: ${result[key]} !== ${expected[key]}`);
  }
}

test('cooperative folds match the former ordered arithmetic exactly, including non-finite cells and boundaries', async () => {
  const cols = columnsOf(9001);
  const x = cols.x.copyRange(0, cols.x.length);
  x[4321] = Number.NaN;
  x[7321] = 1234;
  cols.x.set(x);
  const snapshot = captureRangeStatsSnapshot(cols, 31, 8765, 0.02);
  const expected = reference(snapshot);
  assertExact(computeRangeStatsSync(snapshot), expected);
  let yields = 0;
  const result = await computeRangeStatsAsync(snapshot, {
    sliceMs: 0,
    checkEvery: 512,
    yieldTask: async () => {
      yields++;
    },
  });
  assert.ok(yields > 10);
  assertExact(result, expected);
});

test('signed zero extrema and empty finite channels retain their exact values', async () => {
  const cols = columnsOf(2);
  cols.voltage.set([-0, 0]);
  cols.current.set([Number.NaN, Infinity]);
  const snapshot = captureRangeStatsSnapshot(cols, 0, 1, 1);
  const result = await computeRangeStatsAsync(snapshot);
  assertExact(result, reference(snapshot));
  assert.ok(Object.is(result.minV, -0));
  assert.ok(Object.is(result.maxV, -0));
  assert.equal(result.countC, 0);
});

test('fixed prefix views survive continuing append and buffer growth', async () => {
  const cols = columnsOf(4097);
  const snapshot = captureRangeStatsSnapshot(cols, 0, 4096, 1);
  const expected = reference(snapshot);
  let yields = 0;
  const result = await computeRangeStatsAsync(snapshot, {
    sliceMs: 0,
    yieldTask: async () => {
      yields++;
      for (const [key, col] of Object.entries(cols)) col.push(key === 'x' ? 10 : 42);
    },
  });
  assert.ok(yields > 0);
  assert.notEqual(snapshot.x.length, cols.x.length);
  assert.equal(snapshot.x.length, 4097);
  assert.equal(snapshot.x.valueAt(4096), 4.096);
  assert.equal(result.len, 4097);
  assertExact(result, expected);
});

test('a cancelled or replaced snapshot never publishes a partial result', async () => {
  const cols = columnsOf(5000);
  const snapshot = captureRangeStatsSnapshot(cols, 0, 4999, 1);
  let cancelled = false;
  let yields = 0;
  assert.equal(
    await computeRangeStatsAsync(snapshot, {
      sliceMs: 0,
      isCancelled: () => cancelled,
      yieldTask: async () => {
        yields++;
        cancelled = true;
      },
    }),
    null,
  );
  assert.equal(yields, 1);
  assert.equal(
    await computeRangeStatsAsync(snapshot, {
      sliceMs: 0,
      isCancelled: () => rangeStatsRevision(cols) !== snapshot.revision,
      yieldTask: async () => cols.voltage.set(new Float64Array(5000).fill(8)),
    }),
    null,
  );
});

test('incremental full-history tails produce exactly the same sums and energy as a fresh fold', async () => {
  const cols = columnsOf(8193);
  const prefix = captureRangeStatsSnapshot(cols, 0, 4095, 1);
  // The seed represents the retained full-history snapshot before append.
  prefix.len = 4096;
  const seed = computeRangeStatsSync(prefix);
  const snapshot = captureRangeStatsSnapshot(cols, 0, 8192, 1);
  const expected = reference(snapshot);
  assertExact(computeRangeStatsSync(snapshot, { seed, foldStart: 4096 }), expected);
  assertExact(
    await computeRangeStatsAsync(snapshot, {
      seed,
      foldStart: 4096,
      sliceMs: 0,
      yieldTask: async () => {},
    }),
    expected,
  );
});

test('the default scheduler yields to a real timer before a large scan completes', async () => {
  const cols = columnsOf(16385);
  const snapshot = captureRangeStatsSnapshot(cols, 0, 16384, 1);
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);
  const result = await computeRangeStatsAsync(snapshot, { sliceMs: 0 });
  assert.ok(timerRan);
  assertExact(result, reference(snapshot));
});

test('the real Worker preserves exact folds across mixed cadence, segment and transfer boundaries', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = ModuleWorker;
  try {
    const cols = columnsOf(10031);
    cols.sampleIntervals.set(Float64Array.from({ length: 10031 }, (_, i) => (i < 5000 ? 5000 : 250)));
    cols.x.set(Float64Array.from({ length: 10031 }, (_, i) => (i < 5000 ? i * 5 : 24995 + (i - 4999) * 0.25)));
    const snapshot = captureRangeStatsSnapshot(cols, 17, 10002, 2);
    const expected = computeRangeStatsSync(snapshot);
    const controller = new AbortController();
    const result = await computeRangeStatsBackground(snapshot, { isCancelled: () => false, signal: controller.signal });
    const { columns: _source, ...values } = expected;
    assertExact(result, values);
    assert.equal(result.columns, cols);
    assert.equal(cols.x._chunks[0].byteLength, 4096 * 8, 'source buffers remain attached');
    const worker = ModuleWorker.instances.at(-1);
    assert.ok(
      worker.messages.filter((m) => m.type === 'chunk').every((m) => m.rows <= 4096 && m.bytes <= 4096 * 7 * 8),
    );
    assert.ok(worker.closed);
    const seed = computeRangeStatsSync(captureRangeStatsSnapshot(cols, 0, 4095, 2));
    const full = captureRangeStatsSnapshot(cols, 0, 10030, 2);
    assertExact(
      await computeRangeStatsBackground(full, {
        seed,
        foldStart: 4096,
        isCancelled: () => false,
        signal: controller.signal,
      }),
      Object.fromEntries(Object.entries(computeRangeStatsSync(full)).filter(([key]) => key !== 'columns')),
    );
  } finally {
    globalThis.Worker = previousWorker;
  }
});

test('Worker cancellation returns no partial result and initialization failure uses the exact fallback', async () => {
  const previousWorker = globalThis.Worker;
  const snapshot = captureRangeStatsSnapshot(columnsOf(10001), 0, 10000, 2);
  const controller = new AbortController();
  globalThis.Worker = ModuleWorker;
  try {
    const pending = computeRangeStatsBackground(snapshot, {
      isCancelled: () => controller.signal.aborted,
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(await pending, null);
    assert.ok(ModuleWorker.instances.at(-1).closed);
    globalThis.Worker = class {
      constructor() {
        throw new Error('unavailable');
      }
    };
    const fallback = await computeRangeStatsBackground(snapshot, {
      isCancelled: () => false,
      signal: new AbortController().signal,
    });
    assertExact(fallback, reference(snapshot));
  } finally {
    globalThis.Worker = previousWorker;
  }
});
