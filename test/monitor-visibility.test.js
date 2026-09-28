import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
const frames = [];
globalThis.document = {
  hidden: false,
  getElementById(id) {
    if (!elements.has(id)) {
      let text = '';
      const element = {
        writes: 0,
        style: { transform: '', left: '', width: '' },
        hidden: false,
        title: '',
        value: '',
        attributes: new Map(),
        classList: { toggle() {} },
        get textContent() {
          return text;
        },
        set textContent(value) {
          text = value;
          this.writes++;
        },
        getAttribute(name) {
          return this.attributes.get(name) ?? null;
        },
        setAttribute(name, value) {
          this.attributes.set(name, value);
        },
      };
      elements.set(id, element);
    }
    return elements.get(id);
  },
  querySelector() {
    return { classList: { toggle() {} } };
  },
};
globalThis.requestAnimationFrame = (callback) => {
  frames.push(callback);
  return frames.length;
};
globalThis.cancelAnimationFrame = () => {};

const { emptyChartColumns, setChartColumns, state } = await import('../src/state.js');
const { addDataPoint, refreshMonitorDisplay, resetRealtimeCards, updateChartRange, updateStatsDisplay } = await import(
  '../src/data.js'
);

function flushFrames() {
  while (frames.length) frames.shift()();
}

function reset() {
  elements.clear();
  frames.length = 0;
  setChartColumns(emptyChartColumns());
  state.settings.activeView = 'monitor';
  state.settings.statsRange = false;
  state.settings.signedCurrent = false;
  state.settings.rangeStart = 0;
  state.settings.rangeEnd = 1000;
  state.isRecording = true;
  state.isConnected = true;
  state.recordingStartTime = Date.now();
  state.recordingBaseSeconds = 0;
  state.isTempConnected = false;
  state.autoPauseSettings.enabled = false;
  state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
  state.stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  state.energy = { wh: 0, mah: 0, lastX: null };
  document.hidden = false;
  resetRealtimeCards();
}

test('hidden monitor retains every sample and catches up cards, range and statistics on return', () => {
  reset();
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  flushFrames();
  updateStatsDisplay();
  const voltage = document.getElementById('rt-voltage');
  const range = document.getElementById('range-duration');
  const maximum = document.getElementById('max-voltage');
  const previous = { voltage: voltage.textContent, range: range.textContent, maximum: maximum.textContent };

  state.settings.activeView = 'pd';
  addDataPoint({ voltage: 9, current: 2, power: 18 });
  flushFrames();
  updateStatsDisplay();
  assert.equal(state.chartSeries.x.length, 2);
  assert.equal(state.stats.voltage.max, 9);
  assert.deepEqual({ voltage: voltage.textContent, range: range.textContent, maximum: maximum.textContent }, previous);
  assert.equal(document.getElementById('data-count').textContent, '2');

  state.settings.activeView = 'monitor';
  refreshMonitorDisplay();
  assert.equal(voltage.textContent, '9.0000');
  assert.equal(maximum.textContent, '9.000');
  assert.match(range.textContent, /\(2点\)/);

  const writes = voltage.writes;
  refreshMonitorDisplay();
  assert.equal(voltage.writes, writes, 'unchanged card text should not be written twice');
  flushFrames();
  assert.equal(voltage.writes, writes, 'queued older frames should not repaint after catch-up');
});

test('window visibility also defers local display and restores latest sample', () => {
  reset();
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  flushFrames();
  const voltage = document.getElementById('rt-voltage');
  const writes = voltage.writes;

  document.hidden = true;
  addDataPoint({ voltage: 7, current: 1, power: 7 });
  flushFrames();
  assert.equal(voltage.writes, writes);
  assert.equal(state.chartSeries.x.length, 2);

  document.hidden = false;
  refreshMonitorDisplay();
  assert.equal(voltage.textContent, '7.0000');
});

test('follow window and meter peak advance while another view is open', () => {
  reset();
  state.settings.sampleRate = 1000;
  for (let i = 0; i < 4; i++) addDataPoint({ voltage: 5, current: 1, power: 5 });
  flushFrames();
  const last = state.chartSeries.x.at(-1);
  state.chartWindow = { mode: 'follow', duration: 2, min: last - 2, max: last };
  updateChartRange();
  const startBefore = document.getElementById('range-start-time').textContent;

  state.settings.activeView = 'pd';
  addDataPoint({ voltage: 10, current: 1, power: 10 });
  addDataPoint({ voltage: 5, current: 1, power: 5 });
  flushFrames();
  state.settings.activeView = 'monitor';
  refreshMonitorDisplay();

  assert.equal(state.chartWindow.mode, 'follow');
  assert.equal(state.chartWindow.max, state.chartSeries.x.at(-1));
  assert.notEqual(document.getElementById('range-start-time').textContent, startBefore);
  assert.equal(document.getElementById('lv-voltage').style.transform, 'scaleX(0.5)');
});
