import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, { textContent: '', disabled: false, hidden: false, title: '' });
    }
    return elements.get(id);
  },
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 0;
};

const { state } = await import('../src/state.js');
const { addDataPoint } = await import('../src/data.js');

function resetIngestState() {
  state.isConnected = true;
  state.isRecording = true;
  state.recordingStartTime = Date.now();
  state.recordingBaseSeconds = 0;
  state.lastRecordingStartTime = Date.now();
  state.chartData = {
    timestamps: [],
    voltage: [],
    current: [],
    power: [],
    temp: [],
    dp: [],
    dn: [],
    cc1: [],
    cc2: [],
  };
  state.chartSeries = { x: [], voltage: [], current: [], power: [], temp: [], dp: [], dn: [], cc1: [], cc2: [] };
  state.stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  state.energy = { wh: 0, mah: 0, lastTimestamp: null };
  state.currentTemp = null;
  state.autoPauseSettings.enabled = false;
}

const sample = { voltage: 5, current: -2, power: -10, dp: 2.7, dn: 2.7, cc1: 1.7, cc2: 0 };

test('signed-current ON keeps the sign; power and energy stay non-negative', () => {
  resetIngestState();
  state.settings.signedCurrent = true;
  // 提前一小时的积分基线，让能量段有确定的正 dt
  state.energy.lastTimestamp = Date.now() - 3_600_000;

  addDataPoint(sample);

  assert.equal(state.chartData.current.at(-1), -2);
  assert.equal(state.chartSeries.current.at(-1), -2);
  assert.equal(state.chartData.power.at(-1), 10);
  assert.equal(state.stats.current.min, -2);
  assert.ok(state.energy.mah > 0, 'reverse current must still add capacity');
  assert.ok(state.energy.wh > 0);
});

test('signed-current OFF records the absolute value (legacy behavior)', () => {
  resetIngestState();
  state.settings.signedCurrent = false;

  addDataPoint(sample);

  assert.equal(state.chartData.current.at(-1), 2);
  assert.equal(state.chartSeries.current.at(-1), 2);
  assert.equal(state.stats.current.min, 2);
});

test('signal-line voltages are stored alongside the main channels', () => {
  resetIngestState();
  state.settings.signedCurrent = false;

  addDataPoint(sample);

  assert.equal(state.chartData.dp.at(-1), 2.7);
  assert.equal(state.chartData.dn.at(-1), 2.7);
  assert.equal(state.chartData.cc1.at(-1), 1.7);
  assert.equal(state.chartData.cc2.at(-1), 0);
  assert.equal(state.chartSeries.dp.length, state.chartSeries.x.length);
});

test('missing signal fields are stored as NaN', () => {
  resetIngestState();

  addDataPoint({ voltage: 5, current: 1, power: 5 });

  assert.ok(Number.isNaN(state.chartData.dp.at(-1)));
  assert.ok(Number.isNaN(state.chartData.cc2.at(-1)));
});
