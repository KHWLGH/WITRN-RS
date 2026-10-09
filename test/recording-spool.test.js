import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * In-memory backend for the spool commands: files keyed by handle, bytes decoded as the
 * app sends them, and a switch to make the next write fail.
 */
const backend = {
  files: new Map(),
  calls: [],
  nextHandle: 0,
  failWrites: false,
  onWrite: null,
  reset() {
    this.files.clear();
    this.calls = [];
    this.failWrites = false;
    this.onWrite = null;
  },
};
const decoder = new TextDecoder();

globalThis.window = {
  __TAURI__: {
    event: {
      async listen(_name, callback) {
        backend.tick = callback;
        return () => {};
      },
    },
    core: {
      async invoke(command, args, options) {
        backend.calls.push(command);
        const handle = Number(options?.headers?.['x-handle'] ?? args?.handle);
        switch (command) {
          case 'spool_open': {
            const id = ++backend.nextHandle;
            backend.files.set(id, { text: '', stem: args.stem, headerLen: args.headerLen, synced: 0, closed: false });
            return { handle: id, name: `${args.stem}.csv`, path: `D:/rec/${args.stem}.csv`, size: 0 };
          }
          case 'csv_write_chunk': {
            if (backend.failWrites) throw new Error('磁盘已满');
            backend.files.get(handle).text += decoder.decode(args);
            backend.onWrite?.();
            return null;
          }
          case 'csv_write_patch': {
            const file = backend.files.get(handle);
            const offset = Number(options.headers['x-offset']);
            const patch = decoder.decode(args);
            assert.ok(offset + patch.length <= file.headerLen, 'patches stay inside the header');
            file.text = file.text.slice(0, offset) + patch + file.text.slice(offset + patch.length);
            return null;
          }
          case 'csv_write_sync':
            backend.files.get(handle).synced += 1;
            return null;
          case 'csv_write_close':
            backend.files.get(handle).closed = true;
            return null;
          default:
            return null;
        }
      },
    },
  },
};
globalThis.document = { getElementById: () => null };

const { parseCsv, SPOOL_PATCH_BYTES } = await import('../src/csv-codec.js');
const { emptyChartColumns, state } = await import('../src/state.js');
const spool = await import('../src/recording-spool.js');
const { toast } = await import('../src/ui/toast.js');

const START = new Date(2026, 8, 28, 14, 30, 0).getTime();
const toasts = [];
toast.error = (message) => toasts.push(String(typeof message === 'function' ? message() : message));
let pauses = 0;
spool.configureSpool({ onFailure: () => pauses++ });

/** @param {import('../src/state.js').ChartSeriesColumns} cols @param {number} from @param {number} to */
function addRows(cols, from, to) {
  for (let i = from; i < to; i++) {
    cols.x.push(i * 0.001);
    cols.timestamps.push(START + i);
    cols.voltage.push(9 + i / 1000);
    cols.current.push(1.5);
    cols.power.push((9 + i / 1000) * 1.5);
    cols.temp.push(Number.NaN);
    cols.dp.push(0.6);
    cols.dn.push(0.6);
    cols.cc1.push(1.65);
    cols.cc2.push(0);
    cols.recordingSegments.push(1);
    cols.sampleIntervals.push(1);
  }
}

function prepare(rows) {
  backend.reset();
  toasts.length = 0;
  pauses = 0;
  const cols = emptyChartColumns();
  addRows(cols, 0, rows);
  state.chartSeries = cols;
  state.settings.autoSaveRecording = true;
  state.settings.sampleRate = 1;
  state.dataIntervalMs = null;
  state.lastRecordingStartTime = START;
  state.connectedDevice = /** @type {any} */ ({ model_name: 'POWER-Z KM003C' });
  return cols;
}

/** The only file the backend holds for this test. */
function onlyFile() {
  assert.equal(backend.files.size, 1);
  return [...backend.files.values()][0];
}

test('a spool file starts with the fixed-width header and back-fills existing rows', async () => {
  prepare(3);
  spool.spoolRecordingStarted();
  await spool.spoolRecordingPaused();
  const file = onlyFile();
  assert.match(file.stem, /^KM003C_\d{8}-\d{6}$/);
  assert.equal(file.headerLen, SPOOL_PATCH_BYTES);
  assert.ok(file.text.startsWith('SUM,000000000003\n'), 'the pause patched the row count in place');
  assert.equal(file.synced, 3, 'header, completed backfill and pause are durable');
  assert.equal(file.closed, false, 'a pause keeps the file open for the next segment');
  const parsed = parseCsv(file.text, { fallbackStartTime: 0 });
  assert.equal(parsed.columns.x.length, 3);
  assert.equal(parsed.intervalMs, 1);
  assert.equal(spool.spoolPath(), `D:/rec/${file.stem}.csv`);
  await spool.finalizeSpool();
});

test('finalizing writes the remaining rows, patches the header and closes', async () => {
  const cols = prepare(2);
  spool.spoolRecordingStarted();
  await spool.spoolRecordingPaused();
  addRows(cols, 2, 10_000);
  // Appending is rate-limited to about once a second; the finalize must not lose the backlog.
  spool.spoolRowsAppended();
  await spool.finalizeSpool();
  const file = onlyFile();
  assert.equal(file.closed, true);
  assert.ok(file.text.startsWith('SUM,000000010000\n'));
  const parsed = parseCsv(file.text, { fallbackStartTime: 0 });
  assert.equal(parsed.columns.x.length, 10_000);
  assert.equal(parsed.columns.voltage.at(-1), 9 + 9999 / 1000);
  assert.deepEqual([...new Set(parsed.recordingSegments.view())], [1]);
  assert.equal(spool.spoolPath(), null);
});

test('a new dataset closes the previous file and opens its own', async () => {
  prepare(4);
  spool.spoolRecordingStarted();
  await spool.spoolRecordingPaused();
  const next = emptyChartColumns();
  addRows(next, 0, 2);
  state.chartSeries = next;
  spool.spoolRecordingStarted();
  await spool.finalizeSpool();
  const files = [...backend.files.values()];
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => file.closed));
  assert.equal(parseCsv(files[0].text, { fallbackStartTime: 0 }).columns.x.length, 4);
  assert.equal(parseCsv(files[1].text, { fallbackStartTime: 0 }).columns.x.length, 2);
});

test('nothing is spooled while automatic saving is off', async () => {
  prepare(3);
  state.settings.autoSaveRecording = false;
  spool.spoolRecordingStarted();
  await spool.finalizeSpool();
  assert.equal(backend.files.size, 0);
});

test('a failed write pauses recording once and tells the user the data is still in memory', async () => {
  prepare(3);
  backend.failWrites = true;
  const logError = console.error;
  console.error = () => {};
  try {
    spool.spoolRecordingStarted();
    await spool.finalizeSpool();
  } finally {
    console.error = logError;
  }
  assert.equal(pauses, 1);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /磁盘已满.*data remains in memory/);
  assert.equal(spool.spoolPath(), null);
});

test('native checkpoints drain a low-rate tail and sync without waiting for another sample', async () => {
  const cols = prepare(1);
  spool.spoolRecordingStarted();
  await spool.spoolRecordingPaused();
  const file = onlyFile();
  const before = file.synced;
  addRows(cols, 1, 2);
  backend.tick({ payload: { handle: backend.nextHandle, error: null } });
  for (let i = 0; i < 50 && file.synced === before; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(file.synced > before);
  assert.ok(file.text.startsWith('SUM,000000000002\n'));
  assert.equal(parseCsv(file.text, { fallbackStartTime: 0 }).columns.x.length, 2);
  const calls = backend.calls.length;
  backend.tick({ payload: { handle: backend.nextHandle, error: null } });
  assert.equal(backend.calls.length, calls, 'unchanged or paused data does not rewrite and sync every second');
  await spool.finalizeSpool();
});

test('a large backfill snapshots once, checkpoints within the backlog and never chases appended rows', async () => {
  const cols = prepare(40000);
  const { F64Col } = await import('../src/state.js');
  const original = F64Col.prototype.snapshot;
  let snapshots = 0;
  F64Col.prototype.snapshot = function () {
    snapshots++;
    return original.call(this);
  };
  let bodyWrites = 0;
  backend.onWrite = () => {
    if (++bodyWrites === 2) {
      addRows(cols, 40000, 40001);
      backend.tick({ payload: { handle: backend.nextHandle, error: null } });
    }
  };
  try {
    spool.spoolRecordingStarted();
    await spool.spoolRecordingPaused();
    assert.equal(snapshots, 24, 'one 12-column snapshot for the backlog and one for the frozen tail');
    const file = onlyFile();
    assert.equal(parseCsv(file.text, { fallbackStartTime: 0 }).columns.x.length, 40001);
    const calls = backend.calls;
    assert.ok(
      calls.indexOf('csv_write_patch') < calls.lastIndexOf('csv_write_chunk'),
      'checkpoint runs during the backfill',
    );
    assert.equal(pauses, 0);
  } finally {
    F64Col.prototype.snapshot = original;
    await spool.finalizeSpool();
  }
});
