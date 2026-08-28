import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
/** @type {Map<string, boolean>} */
const classToggles = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, { textContent: '', disabled: false, hidden: false, title: '' });
    }
    return elements.get(id);
  },
  querySelector(sel) {
    if (sel === '.chart-container') {
      return {
        classList: {
          toggle(name, on) {
            classToggles.set(name, !!on);
          },
        },
      };
    }
    return null;
  },
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 0;
};

const { emptyChartColumns, setChartColumns, state } = await import('../src/state.js');
const { addDataPoint, updateChartEmptyState } = await import('../src/data.js');

function resetIngestState() {
  state.isConnected = true;
  state.isRecording = true;
  state.recordingStartTime = Date.now();
  state.recordingBaseSeconds = 0;
  state.lastRecordingStartTime = Date.now();
  setChartColumns(emptyChartColumns());
  state.stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  state.energy = { wh: 0, mah: 0, lastX: null };
  state.currentTemp = null;
  state.isTempConnected = false;
  state.settings.tempSource = 'external';
  state.autoPauseSettings.enabled = false;
}

const sample = { voltage: 5, current: -2, power: -10, dp: 2.7, dn: 2.7, cc1: 1.7, cc2: 0 };

test('signed-current ON keeps the sign; power and energy stay non-negative', () => {
  resetIngestState();
  state.settings.signedCurrent = true;
  // 积分基线落后一个采样间隔，保证 dt 为正且不超过空档上限
  state.energy.lastX = 0;
  state.recordingBaseSeconds = 1;

  addDataPoint(sample);

    assert.equal(state.chartSeries.current.at(-1), -2);
  assert.equal(state.chartSeries.power.at(-1), 10);
  assert.equal(state.stats.current.min, -2);
  assert.ok(state.energy.mah > 0, 'reverse current must still add capacity');
  assert.ok(state.energy.wh > 0);
});

test('signed-current OFF records the absolute value (legacy behavior)', () => {
  resetIngestState();
  state.settings.signedCurrent = false;

  addDataPoint(sample);

  assert.equal(state.chartSeries.current.at(-1), 2);
  assert.equal(state.stats.current.min, 2);
});

test('signal-line voltages are stored alongside the main channels', () => {
  resetIngestState();
  state.settings.signedCurrent = false;

  addDataPoint(sample);

  assert.equal(state.chartSeries.dp.at(-1), 2.7);
  assert.equal(state.chartSeries.dn.at(-1), 2.7);
  assert.equal(state.chartSeries.cc1.at(-1), 1.7);
  assert.equal(state.chartSeries.cc2.at(-1), 0);
  assert.equal(state.chartSeries.dp.length, state.chartSeries.x.length);
});

test('missing signal fields are stored as NaN', () => {
  resetIngestState();

  addDataPoint({ voltage: 5, current: 1, power: 5 });

  assert.ok(Number.isNaN(state.chartSeries.dp.at(-1)));
  assert.ok(Number.isNaN(state.chartSeries.cc2.at(-1)));
});

test('out-of-range D+/D- are stored as NaN', () => {
  resetIngestState();
  addDataPoint({ voltage: 5, current: 1, power: 5, dp: 1e20, dn: 2.7 });
  assert.ok(Number.isNaN(state.chartSeries.dp.at(-1)));
  assert.equal(state.chartSeries.dn.at(-1), 2.7);
});

test('HID temperature is ignored until the temperature service is connected', () => {
  resetIngestState();
  state.settings.tempSource = 'device';
  addDataPoint({ voltage: 5, current: 1, power: 5, temperature: 36.5 });
  assert.ok(Number.isNaN(state.chartSeries.temp.at(-1)));
});

test('device temperature source records HID temperature', () => {
  resetIngestState();
  state.settings.tempSource = 'device';
  state.isTempConnected = true;
  addDataPoint({ voltage: 5, current: 1, power: 5, temperature: 36.5 });
  assert.equal(state.chartSeries.temp.at(-1), 36.5);
});

test('external temperature source prefers TCP over HID', () => {
  resetIngestState();
  state.settings.tempSource = 'external';
  state.isTempConnected = true;
  state.currentTemp = 21.25;
  addDataPoint({ voltage: 5, current: 1, power: 5, temperature: 36.5 });
  assert.equal(state.chartSeries.temp.at(-1), 21.25);
});

test('a sleep-sized wall-clock jump does not explode energy', () => {
  resetIngestState();
  state.settings.sampleRate = 250;
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  const firstX = state.chartSeries.x.at(-1);
  const whBefore = state.energy.wh;
  state.recordingStartTime = Date.now() - 3_600_000;
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  const dx = state.chartSeries.x.at(-1) - firstX;
  assert.ok(dx < 1, `x jumped ${dx}s across a simulated sleep`);
  assert.ok(state.energy.wh - whBefore < 0.01, 'hour-long sleep must not integrate as one hour');
});

test('colliding wall-clock samples still advance x and energy', () => {
  resetIngestState();
  state.settings.sampleRate = 250;
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  const firstX = state.chartSeries.x.at(-1);
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  assert.ok(state.chartSeries.x.at(-1) > firstX);
  assert.ok(state.energy.wh > 0);
});

test('updateChartEmptyState toggles has-data from series length', () => {
  resetIngestState();
  classToggles.clear();
  updateChartEmptyState();
  assert.equal(classToggles.get('has-data'), false);

  addDataPoint(sample);
  updateChartEmptyState();
  assert.equal(classToggles.get('has-data'), true);
});
