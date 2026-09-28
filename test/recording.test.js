import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = {
  __TAURI__: {
    core: { invoke: async () => null },
  },
};

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      // 命令栏镜像（ui/controlbar.js）会写 innerHTML / title / classList / aria-*，
      // stub 需要这些成员，否则 startRecording 会在同步 UI 时抛错
      elements.set(id, {
        textContent: '',
        disabled: false,
        innerHTML: '',
        title: '',
        style: {},
        classList: { toggle() {} },
        setAttribute() {},
      });
    }
    return elements.get(id);
  },
};

const { emptyChartColumns, setChartColumns, state } = await import('../src/state.js');
const { startRecording, stopRecording } = await import('../src/data.js');

function resetRecordingState() {
  // 实时落盘有独立测试（recording-spool.test.js）；这里的桩后端不提供文件句柄。
  state.settings.autoSaveRecording = false;
  state.isConnected = true;
  state.isRecording = false;
  state.recordingStartTime = null;
  state.recordingBaseSeconds = 0;
  state.lastRecordingStartTime = null;
  setChartColumns(emptyChartColumns());
  state.chartWindow = { mode: 'full', duration: 0, min: 0, max: 0 };
  state.settings.rangeStart = 0;
  state.settings.rangeEnd = 1000;
  state.__rangeDragging = false;
  state.energy = { wh: 12, mah: 34, lastX: 1234 };
  state.autoPauseSettings.triggerStartTime = 5678;
}

test('recording session boundaries reset integration and auto-pause baselines', async () => {
  resetRecordingState();

  await startRecording();
  assert.equal(state.isRecording, true);
  assert.equal(state.energy.lastX, null);
  assert.equal(state.autoPauseSettings.triggerStartTime, null);

  state.energy.lastX = 9999;
  state.autoPauseSettings.triggerStartTime = 9999;
  stopRecording();
  assert.equal(state.isRecording, false);
  assert.equal(state.energy.lastX, null);
  assert.equal(state.autoPauseSettings.triggerStartTime, null);
});

test('recording after an import continues from the last relative x value', async () => {
  resetRecordingState();
  state.chartSeries.timestamps.set([1_000_000, 2_000_000]);
  state.chartSeries.x.set([3723.5, 3724.5]);
  state.settings.sampleRate = 250;

  await startRecording();
  assert.equal(state.recordingBaseSeconds, 3724.75);
  stopRecording();
});

test('startRecording keeps an existing zoom window and does not disable the slider', async () => {
  resetRecordingState();
  state.settings.rangeStart = 200;
  state.settings.rangeEnd = 800;
  state.chartWindow = { mode: 'frozen', duration: 2, min: 1, max: 3 };
  /** @type {boolean|undefined} */
  let lastEnabled;
  state.__setRangeControlsEnabled = (enabled) => {
    lastEnabled = enabled;
  };

  await startRecording();
  assert.equal(state.settings.rangeStart, 200);
  assert.equal(state.settings.rangeEnd, 800);
  assert.equal(state.chartWindow.mode, 'frozen');
  assert.equal(state.chartWindow.min, 1);
  assert.equal(state.chartWindow.max, 3);
  assert.notEqual(lastEnabled, false);
  stopRecording();
});

test('startRecording is not re-entrant while PD capture is enabling', async () => {
  resetRecordingState();
  let enableCalls = 0;
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const invoke = globalThis.window.__TAURI__.core.invoke;
  globalThis.window.__TAURI__.core.invoke = async (cmd) => {
    if (cmd === 'set_pd_capture_enabled') {
      enableCalls += 1;
      await gate;
    }
    return null;
  };
  try {
    const first = startRecording();
    const second = startRecording();
    release();
    await Promise.all([first, second]);
    assert.equal(enableCalls, 1);
    assert.equal(state.isRecording, true);
  } finally {
    globalThis.window.__TAURI__.core.invoke = invoke;
    stopRecording();
  }
});

const { deviceStream } = await import('../src/device-stream.js');
const { calculateEnergyInRange } = await import('../src/measurement.js');
const { formatCsvChunks, parseCsv, snapshotCsvColumns } = await import('../src/csv-codec.js');
const { getRangeStats, updateStatsDisplay } = await import('../src/data.js');
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
let generation = 0;
let boundary = 0;
let rejectPause = false;

function openNativeStream() {
  resetRecordingState();
  state.settings.sampleRate = 10;
  state.settings.signedCurrent = true;
  state.autoPauseSettings.enabled = false;
  state.energy = { wh: 0, mah: 0, lastX: null };
  for (const key of ['voltage', 'current', 'power', 'temp']) {
    state.stats[key] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  }
  boundary = 0;
  rejectPause = false;
  window.__TAURI__.core.invoke = async (command, args) => {
    if (command === 'set_recording_segment') {
      if (rejectPause && args.segment === 0) throw new Error('pause rejected');
      return { generation, after_seq: boundary, segment: args.segment };
    }
    if (command === 'drain_device_stream') return { generation, last_seq: deviceStream.lastSeq };
  };
  deviceStream.configure({ onError() {}, onEnd() {} });
  deviceStream.enable();
  deviceStream.open({ generation: ++generation, wall_anchor_ms: 1704067200000 });
}

function nativeSample(seq, segment = 1, start = 10000) {
  return {
    generation,
    seq,
    segment,
    received_us: seq * 10000,
    segment_start_us: start,
    wall_anchor_ms: 1704067200000,
    rate_ms: 10,
    voltage: 12 + seq / 7,
    current: -seq / 13,
    power: -seq / 11,
  };
}

function assertExactEnergy(intervalMs = state.dataIntervalMs ?? state.settings.sampleRate) {
  const cols = state.chartSeries;
  const expected = calculateEnergyInRange(
    cols.x.view(),
    cols.current.view(),
    cols.power.view(),
    0,
    cols.x.length - 1,
    cols.recordingSegments.view(),
    intervalMs,
  );
  assert.deepEqual({ wh: state.energy.wh, mah: state.energy.mah }, expected);
  const range = getRangeStats();
  assert.deepEqual({ wh: range.wh, mah: range.mah }, expected);
  const encoded = [
    ...formatCsvChunks(snapshotCsvColumns(cols, { sampleRate: intervalMs, startTime: 1704067200000 })),
  ].join('');
  const decodedFile = parseCsv(encoded, { fallbackStartTime: 0 });
  const decoded = decodedFile.columns;
  for (const key of Object.keys(cols)) assert.deepEqual(decoded[key].view(), cols[key].view(), key);
  assert.deepEqual(
    calculateEnergyInRange(
      decoded.x.view(),
      decoded.current.view(),
      decoded.power.view(),
      0,
      decoded.x.length - 1,
      decoded.recordingSegments.view(),
      decodedFile.intervalMs,
    ),
    expected,
  );
}

test('a 5s preset keeps live, range and CSV-round-trip energy identical', async () => {
  openNativeStream();
  state.settings.sampleRate = 5000;
  /** @param {number} seq @param {number} [extraUs] 额外推进的时钟微秒数，用来造空档 */
  const slow = (seq, extraUs = 0) => {
    const sample = nativeSample(seq);
    sample.rate_ms = 5000;
    sample.received_us = seq * 5_000_000 + extraUs;
    return sample;
  };
  await startRecording();
  deviceStream.handleBatch([slow(1), slow(2), slow(3)]);
  await deviceStream.settle();
  assert.ok(state.energy.wh > 0, '5 秒档必须积得到自己的节奏，而不是恒为 0');
  assert.equal(state.dataIntervalMs, 5000);
  assertExactEnergy(5000);

  // 同一记录段内的 30 分钟空档：x 轴按真实间隔继续，能量把它当休眠跳过
  const beforeHole = state.energy.wh;
  deviceStream.handleBatch([slow(4, 1_800_000_000)]);
  await deviceStream.settle();
  const x = state.chartSeries.x.view();
  assert.ok(x[x.length - 1] - x[x.length - 2] > 1800, 'x 轴必须保留真实空档');
  assert.equal(state.energy.wh, beforeHole, '1800 秒空档不能积进能量');
  assertExactEnergy(5000);
  boundary = 4;
  await stopRecording();
});

test('native manual pause resolves after retained samples and preserves exact energy across resume', async () => {
  openNativeStream();
  await startRecording();
  deviceStream.handleBatch([nativeSample(1), nativeSample(2)]);
  boundary = 4;
  let settled = false;
  const paused = stopRecording().then(() => {
    settled = true;
  });
  assert.equal(state.isRecording, false);
  await Promise.resolve();
  assert.equal(settled, false);
  deviceStream.handleBatch([nativeSample(3), nativeSample(4), nativeSample(5, 0)]);
  await paused;
  assert.equal(state.chartSeries.x.length, 4);
  assertExactEnergy();
  boundary = 5;
  await startRecording();
  deviceStream.handleBatch([nativeSample(6, 2, 60000), nativeSample(7, 2, 60000)]);
  assert.deepEqual([...state.chartSeries.recordingSegments.view()], [1, 1, 1, 1, 2, 2]);
  assertExactEnergy();
  boundary = 7;
  await stopRecording();
  assert.ok(frames.size <= 2, 'sample batches must coalesce instead of queuing one UI callback per point');
});

test('native auto-pause records the triggering sample but not the rest of its batch', async () => {
  openNativeStream();
  await startRecording();
  state.autoPauseSettings = { enabled: true, basis: 'current', condition: 1, duration: 0, triggerStartTime: null };
  deviceStream.handleBatch([nativeSample(1), nativeSample(2), nativeSample(3)]);
  await deviceStream.settle();
  assert.equal(state.isRecording, false);
  assert.equal(state.chartSeries.x.length, 1);
  assert.equal(deviceStream.lastSeq, 3);
  assertExactEnergy();
});

test('live energy skips non-finite power/current exactly like the range integrator', async () => {
  openNativeStream();
  await startRecording();
  const bad = nativeSample(2);
  bad.current = Number.NaN;
  bad.power = Number.NaN;
  deviceStream.handleBatch([nativeSample(1), bad, nativeSample(3)]);
  await deviceStream.settle();
  assert.ok(Number.isFinite(state.energy.wh), 'a NaN sample must not poison cumulative energy');
  assert.ok(Number.isFinite(state.energy.mah));
  assertExactEnergy();
  boundary = 3;
  await stopRecording();
});

const CSV_FIXTURE = 'Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n00:00:00,5,2,10,\n00:00:01,6,3,18,';

/**
 * Backend file commands for one CSV: a pick returns a handle, reads return the bytes once
 * and then an empty slice. Everything else falls through to `fallback`.
 * @param {(cmd: string, args?: any) => Promise<unknown>} fallback
 */
function csvFileBackend(fallback, text = CSV_FIXTURE) {
  const reads = new Map();
  return async (cmd, args) => {
    if (cmd === 'csv_import_pick') return { handle: 7, name: '记录.csv', path: 'C:/记录.csv', size: text.length };
    if (cmd === 'csv_read_chunk') {
      const done = reads.get(args.handle) ?? false;
      reads.set(args.handle, true);
      return done ? new ArrayBuffer(0) : new TextEncoder().encode(text).buffer;
    }
    if (cmd === 'csv_read_close') return null;
    return fallback(cmd, args);
  };
}

test('CSV import waits for the pause boundary and does not replace data if it fails', async () => {
  const { createCsvImport } = await import('../src/csv-import-core.js');
  // Node has no browser Worker; keep the asynchronous begin/chunk/end protocol and transfer boundary.
  globalThis.Worker = class {
    terminated = false;
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    /** @param {any} message */
    postMessage(message) {
      setImmediate(() => {
        if (this.terminated) return;
        try {
          if (message.type === 'begin') {
            this.session = createCsvImport(message.options);
            this.decoder = new TextDecoder();
            this.onmessage?.({ data: { type: 'ready' } });
          } else if (message.type === 'chunk') {
            this.session.push(this.decoder.decode(new Uint8Array(message.bytes), { stream: true }));
            this.onmessage?.({ data: { type: 'ack', rows: this.session.rows } });
          } else if (message.type === 'end') {
            this.session.push(this.decoder.decode());
            const result = this.session.finish();
            const transfer = Object.values(result.columns).flatMap((column) => column._chunks.map((c) => c.buffer));
            this.onmessage?.({ data: { type: 'done', result: structuredClone(result, { transfer }) } });
          }
        } catch (error) {
          this.onmessage?.({ data: { type: 'error', error: error.message } });
        }
      });
    }
    terminate() {
      this.terminated = true;
    }
  };
  const messages = [];
  const invoke = window.__TAURI__.core.invoke;
  // No HTMLDialogElement in Node: ask() falls back to the dialog plugin.
  window.__TAURI__.dialog = { ask: async () => true };
  const { toast } = await import('../src/ui/toast.js');
  const { importCSV } = await import('../src/csv.js');
  toast.success = (message) => messages.push(['success', message]);
  toast.error = (message) => messages.push(['error', message]);
  toast.info = () => {};
  try {
    openNativeStream();
    window.__TAURI__.core.invoke = csvFileBackend(window.__TAURI__.core.invoke);
    await startRecording();
    deviceStream.handleBatch([nativeSample(1)]);
    const original = state.chartSeries;
    rejectPause = true;
    const logError = console.error;
    console.error = () => {};
    try {
      await importCSV();
    } finally {
      console.error = logError;
    }
    assert.equal(state.chartSeries, original);
    assert.equal(original.x.length, 1);
    assert.match(messages.at(-1)[1], /pause rejected/);
    assert.equal(
      messages.some(([kind]) => kind === 'success'),
      false,
    );

    openNativeStream();
    window.__TAURI__.core.invoke = csvFileBackend(window.__TAURI__.core.invoke);
    await startRecording();
    deviceStream.handleBatch([nativeSample(1)]);
    const beforeImport = state.chartSeries;
    boundary = 2;
    const importing = importCSV();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.chartSeries, beforeImport);
    deviceStream.handleBatch([nativeSample(2)]);
    await importing;
    assert.notEqual(state.chartSeries, beforeImport);
    assert.deepEqual([...state.chartSeries.voltage.view()], [5, 6]);
    assert.equal(messages.at(-1)[0], 'success');
    await deviceStream.settle();
  } finally {
    window.__TAURI__.core.invoke = invoke;
  }
});

test('a new import cancels the prior worker; late replies and parse failure preserve the live columns', async () => {
  const { importCSV } = await import('../src/csv.js');
  const previousWorker = globalThis.Worker;
  const invoke = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = csvFileBackend(invoke);
  const workers = [];
  globalThis.Worker = class {
    constructor() {
      workers.push(this);
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  };
  const original = state.chartSeries;
  const buffer = original.x.buf.buffer;
  const logError = console.error;
  console.error = () => {};
  try {
    const first = importCSV();
    await new Promise((resolve) => setImmediate(resolve));
    const second = importCSV();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workers[0].terminated, true);
    workers[0].onmessage({ data: { type: 'done', result: {} } });
    workers[1].onmessage({ data: { type: 'error', error: 'invalid test CSV' } });
    await Promise.all([first, second]);
    assert.equal(state.chartSeries, original);
    assert.equal(original.x.buf.buffer, buffer);
    assert.ok(buffer.byteLength > 0);
    assert.equal(workers[1].terminated, true);
  } finally {
    globalThis.Worker = previousWorker;
    window.__TAURI__.core.invoke = invoke;
    console.error = logError;
  }
});

// ─── 范围统计的非有限值口径 ─────────────────────────────────────────────────
// 导入精确 CSV 时按设计保留 NaN / ±Infinity（见 csv-codec.test.js），所以这些值
// 会真的进到列缓冲里；范围统计必须像全量统计一样只折入有限值。

/** @param {number} seq */
function voltageOf(seq) {
  return 12 + seq / 7;
}

/** @param {number} seq @param {number} voltage */
function nativeVoltageSample(seq, voltage) {
  const sample = nativeSample(seq);
  sample.voltage = voltage;
  return sample;
}

test('range stats skip the non-finite cells the importer keeps', async () => {
  openNativeStream();
  await startRecording();
  const finite = [voltageOf(1), voltageOf(3), voltageOf(4)];
  deviceStream.handleBatch([
    nativeVoltageSample(1, finite[0]),
    nativeVoltageSample(2, Number.NaN),
    nativeVoltageSample(3, finite[1]),
    nativeVoltageSample(4, finite[2]),
  ]);
  await deviceStream.settle();
  boundary = 4;
  state.settings.statsRange = true;
  try {
    const range = getRangeStats();
    assert.equal(range.countV, 3, '一个缺失样本不能把 count 也算进均值');
    assert.equal(range.sumV, finite[0] + finite[1] + finite[2]);
    updateStatsDisplay();
    assert.equal(
      document.getElementById('avg-voltage').textContent,
      (finite.reduce((a, b) => a + b, 0) / finite.length).toFixed(3),
    );
  } finally {
    state.settings.statsRange = false;
    await stopRecording();
  }
});

test('range mode and whole-history mode report the same mean', async () => {
  openNativeStream();
  await startRecording();
  deviceStream.handleBatch([
    nativeVoltageSample(1, voltageOf(1)),
    nativeVoltageSample(2, Number.NaN),
    nativeVoltageSample(3, voltageOf(3)),
  ]);
  await deviceStream.settle();
  boundary = 3;
  updateStatsDisplay();
  const wholeHistory = document.getElementById('avg-voltage').textContent;
  state.settings.statsRange = true;
  try {
    updateStatsDisplay();
    assert.equal(document.getElementById('avg-voltage').textContent, wholeHistory, '两种模式必须同口径');
  } finally {
    state.settings.statsRange = false;
    await stopRecording();
  }
});

test('an all-NaN channel reads as a dash instead of the literal NaN', async () => {
  openNativeStream();
  await startRecording();
  deviceStream.handleBatch([nativeVoltageSample(1, Number.NaN), nativeVoltageSample(2, Number.NaN)]);
  await deviceStream.settle();
  boundary = 2;
  state.settings.statsRange = true;
  try {
    updateStatsDisplay();
    assert.equal(document.getElementById('avg-voltage').textContent, '--');
    assert.equal(document.getElementById('min-voltage').textContent, '--');
    assert.equal(document.getElementById('max-voltage').textContent, '--');
  } finally {
    state.settings.statsRange = false;
    await stopRecording();
  }
});

test('infinite cells cannot win min or max', async () => {
  openNativeStream();
  await startRecording();
  deviceStream.handleBatch([
    nativeVoltageSample(1, 5),
    nativeVoltageSample(2, Number.POSITIVE_INFINITY),
    nativeVoltageSample(3, Number.NEGATIVE_INFINITY),
    nativeVoltageSample(4, 6),
  ]);
  await deviceStream.settle();
  boundary = 4;
  state.settings.statsRange = true;
  try {
    const range = getRangeStats();
    assert.equal(range.minV, 5);
    assert.equal(range.maxV, 6);
    assert.equal(range.countV, 2);
    updateStatsDisplay();
    assert.equal(document.getElementById('min-voltage').textContent, '5.000');
    assert.equal(document.getElementById('max-voltage').textContent, '6.000');
  } finally {
    state.settings.statsRange = false;
    await stopRecording();
  }
});

test('the incremental range fold skips non-finite tail points too', async () => {
  openNativeStream();
  await startRecording();
  deviceStream.handleBatch([nativeVoltageSample(1, voltageOf(1)), nativeVoltageSample(2, voltageOf(2))]);
  await deviceStream.settle();
  state.settings.statsRange = true;
  try {
    assert.equal(getRangeStats().countV, 2);
    deviceStream.handleBatch([nativeVoltageSample(3, Number.NaN)]);
    await deviceStream.settle();
    assert.equal(getRangeStats().countV, 2, '只折入新尾段的复用分支也必须跳过非有限值');
  } finally {
    state.settings.statsRange = false;
    await stopRecording();
  }
});

test('a terminal stream error flips the connection state, not just recording', async () => {
  openNativeStream();
  await startRecording();
  window.__TAURI__.event = { listen: async () => () => {} };
  const { toast } = await import('../src/ui/toast.js');
  toast.error = () => {};
  const { initializeDeviceStream } = await import('../src/device.js');
  await initializeDeviceStream();

  deviceStream.handleBatch([nativeSample(1), nativeSample(3)]);
  await deviceStream.settle();

  assert.equal(state.isRecording, false);
  assert.equal(state.isConnected, false, '流已经死了，底栏不能还显示「已连接」');
  assert.equal(deviceStream.diagnostics().failed, true);
});

test('a skipped cell is disclosed on the mean instead of silently dropped', async () => {
  openNativeStream();
  await startRecording();
  deviceStream.handleBatch([
    nativeVoltageSample(1, voltageOf(1)),
    nativeVoltageSample(2, Number.NaN),
    nativeVoltageSample(3, voltageOf(3)),
  ]);
  await deviceStream.settle();
  boundary = 3;
  state.settings.statsRange = true;
  try {
    updateStatsDisplay();
    assert.equal(document.getElementById('avg-voltage').title, '1 个样本值缺失，未计入');
    assert.equal(document.getElementById('avg-current').title, '', '完整通道不该出现缺失提示');
  } finally {
    state.settings.statsRange = false;
    await stopRecording();
  }
});
