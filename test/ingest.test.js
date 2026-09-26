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

test('a slow preset still accumulates energy at its own cadence', () => {
  // 非原生路径的 x 由挂钟推出，所以这里控制时钟；否则「步进刚好等于采样间隔」
  // 这件事本身就不确定，断言会退化成只要 wh > 0 就算过。
  const realNow = Date.now;
  try {
    let now = 1_704_067_200_000;
    Date.now = () => now;
    resetIngestState();
    state.settings.sampleRate = 5000;
    addDataPoint({ voltage: 5, current: 1, power: 10 });
    now += 5000;
    addDataPoint({ voltage: 5, current: 1, power: 10 });
    assert.ok(Math.abs(state.energy.wh - 10 * (5 / 3600)) < 1e-9, `实测 ${state.energy.wh}`);
    assert.equal(state.chartSeries.x.at(-1), 5, 'x 轴也按 5 秒推进');
  } finally {
    Date.now = realNow;
  }
});

test('native samples accumulate energy from the device-reported rate', () => {
  resetIngestState();
  state.settings.sampleRate = 5000;
  const segment = { id: 1, generation: 1, columns: null, baseSeconds: 0, lastX: null, first: true };
  const native = (seq) => ({
    generation: 1,
    seq,
    segment: 1,
    received_us: seq * 5_000_000,
    segment_start_us: 0,
    wall_anchor_ms: 1_704_067_200_000,
    rate_ms: 5000,
    voltage: 5,
    current: 1,
    power: 10,
  });
  addDataPoint(native(1), segment);
  addDataPoint(native(2), segment);
  assert.ok(Math.abs(state.energy.wh - 10 * (5 / 3600)) < 1e-9, `实测 ${state.energy.wh}`);
});

test('a hole larger than the scaled threshold stays excluded', () => {
  resetIngestState();
  state.settings.sampleRate = 5000;
  const segment = { id: 1, generation: 1, columns: null, baseSeconds: 0, lastX: null, first: true };
  const native = (receivedUs) => ({
    generation: 1,
    seq: 1,
    segment: 1,
    received_us: receivedUs,
    segment_start_us: 0,
    wall_anchor_ms: 1_704_067_200_000,
    rate_ms: 5000,
    voltage: 5,
    current: 1,
    power: 10,
  });
  addDataPoint(native(0), segment);
  addDataPoint(native(3_600_000_000), segment);
  assert.equal(state.energy.wh, 0, '休眠一小时不能按一小时积分');
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
