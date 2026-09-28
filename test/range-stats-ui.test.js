import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };
const elements = new Map();
globalThis.document = {
  hidden: false,
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '',
        title: '',
        hidden: false,
        value: '',
        style: { transform: '', left: '', width: '' },
        classList: { toggle() {} },
        attributes: new Map(),
        getAttribute(name) {
          return this.attributes.get(name) ?? null;
        },
        setAttribute(name, value) {
          this.attributes.set(name, value);
        },
      });
    }
    return elements.get(id);
  },
  querySelector() {
    return { classList: { toggle() {} } };
  },
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

let ticks = 0;
globalThis.performance = { now: () => ticks++ };
const timers = [];
let timerId = 0;
globalThis.setTimeout = (callback, delay) => {
  const id = ++timerId;
  timers.push({ id, callback, delay });
  return id;
};
globalThis.clearTimeout = (id) => {
  const index = timers.findIndex((entry) => entry.id === id);
  if (index >= 0) timers.splice(index, 1);
};

const { emptyChartColumns, setChartColumns, state } = await import('../src/state.js');
const {
  clearChart,
  getRangeStats,
  getRangeStatsAsync,
  scheduleStatsUpdate,
  updateChartRange,
  updateEnergyDisplay,
  updateRealtimeDisplay,
  updateStatsDisplay,
} = await import('../src/data.js');

function loadColumns(count = 20000, voltage = 5) {
  const cols = emptyChartColumns();
  for (const [key, col] of Object.entries(cols)) {
    const values = new Float64Array(count);
    if (key === 'x' || key === 'timestamps') {
      for (let i = 0; i < count; i++) values[i] = i * 0.001;
    } else values.fill(key === 'voltage' || key === 'power' ? voltage : 1);
    col.set(values);
  }
  setChartColumns(cols);
  return cols;
}

function reset(count = 20000) {
  state.settings.activeView = 'monitor';
  state.settings.statsRange = false;
  state.settings.rangeStart = 0;
  state.settings.rangeEnd = 1000;
  state.settings.sampleRate = 1;
  state.dataIntervalMs = 1;
  state.isRecording = false;
  state.chartWindow = { mode: 'full', duration: 0, min: 0, max: 0 };
  document.hidden = false;
  updateStatsDisplay();
  timers.length = 0;
  const cols = loadColumns(count);
  state.settings.statsRange = true;
  return cols;
}

async function flushSlices() {
  let count = 0;
  while (timers.some((entry) => entry.delay === 0)) {
    assert.ok(count++ < 1000, 'range task must finish without starvation');
    const index = timers.findIndex((entry) => entry.delay === 0);
    timers.splice(index, 1)[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

test('UI large ranges and energy use pending async snapshots while realtime cards stay immediate', async () => {
  reset();
  updateStatsDisplay();
  updateEnergyDisplay();
  assert.equal(document.getElementById('avg-voltage').textContent, '--');
  assert.equal(document.getElementById('avg-voltage').getAttribute('aria-busy'), 'true');
  assert.equal(document.getElementById('rt-energy').textContent, '--');
  const task = getRangeStatsAsync();
  updateRealtimeDisplay({ voltage: 8, current: 2, power: 16, temp: 30 });
  assert.equal(document.getElementById('rt-voltage').textContent, '8.0000');
  assert.equal(getRangeStatsAsync(), task, 'card and energy updates must share one snapshot task');
  await flushSlices();
  const result = await task;
  assert.equal(result.countV, 20000);
  assert.equal(document.getElementById('avg-voltage').textContent, '5.000');
  assert.equal(document.getElementById('avg-voltage').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('rt-energy').textContent, result.wh.toFixed(4));
  assert.deepEqual(result, getRangeStats());
});

test('short ranges stay synchronous in both stats and energy displays', () => {
  reset(16);
  updateStatsDisplay();
  updateEnergyDisplay();
  assert.equal(document.getElementById('avg-voltage').textContent, '5.000');
  assert.equal(document.getElementById('avg-voltage').getAttribute('aria-busy'), 'false');
  assert.equal(timers.filter((entry) => entry.delay === 0).length, 0);
});

test('window changes clear previous labels and cancel an unfinished range', async () => {
  reset();
  const oldTask = getRangeStatsAsync();
  state.chartWindow = { mode: 'frozen', duration: 2, min: 7, max: 9 };
  scheduleStatsUpdate();
  assert.equal(document.getElementById('avg-voltage').textContent, '--');
  updateStatsDisplay();
  assert.equal(document.getElementById('avg-voltage').textContent, '5.000');
  await flushSlices();
  assert.equal(await oldTask, null);
  assert.equal(getRangeStats().startIndex, 7000);
});

test('moving away from an already displayed window marks its stats pending with the new range labels', async () => {
  reset();
  state.chartWindow = { mode: 'frozen', duration: 1, min: 7, max: 8 };
  updateStatsDisplay();
  updateEnergyDisplay();
  assert.equal(document.getElementById('avg-voltage').textContent, '5.000');
  assert.notEqual(document.getElementById('rt-energy').textContent, '--');
  state.chartWindow = { mode: 'frozen', duration: 12, min: 1, max: 13 };
  updateChartRange();
  assert.equal(document.getElementById('avg-voltage').textContent, '--');
  assert.equal(document.getElementById('rt-energy').textContent, '--');
  assert.equal(document.getElementById('rt-energy').getAttribute('aria-busy'), 'true');
  const task = getRangeStatsAsync();
  await flushSlices();
  assert.ok(await task);
  assert.equal(document.getElementById('rt-energy').getAttribute('aria-busy'), 'false');
});

test('same-column mutation and column replacement cancel old jobs before publishing', async () => {
  const cols = reset();
  const oldTask = getRangeStatsAsync();
  cols.voltage.set(new Float64Array(20000).fill(11));
  const replacementTask = getRangeStatsAsync();
  assert.notEqual(replacementTask, oldTask);
  await flushSlices();
  assert.equal(await oldTask, null);
  assert.equal((await replacementTask).sumV, 220000);
  assert.equal(document.getElementById('avg-voltage').textContent, '11.000');

  reset();
  const replaced = getRangeStatsAsync();
  loadColumns(20000, 9);
  const current = getRangeStatsAsync();
  await flushSlices();
  assert.equal(await replaced, null);
  assert.equal((await current).sumV, 180000);
  assert.equal(document.getElementById('avg-voltage').textContent, '9.000');
});

test('clear and hidden views cancel jobs without stale UI writes', async () => {
  reset();
  const cleared = getRangeStatsAsync();
  clearChart();
  await flushSlices();
  assert.equal(await cleared, null);
  assert.equal(state.chartSeries.x.length, 0);

  reset();
  updateStatsDisplay();
  const hidden = getRangeStatsAsync();
  document.hidden = true;
  await flushSlices();
  assert.equal(await hidden, null);
  assert.equal(document.getElementById('avg-voltage').textContent, '--');
  document.hidden = false;
  updateStatsDisplay();
  const visible = getRangeStatsAsync();
  await flushSlices();
  assert.ok(await visible);
  assert.equal(document.getElementById('avg-voltage').textContent, '5.000');
});

test('continuous follow growth lets the fixed snapshot finish and never mislabels its old result', async () => {
  const cols = reset(25000);
  state.chartWindow = { mode: 'follow', duration: 15, min: 9.999, max: 24.999 };
  updateStatsDisplay();
  const task = getRangeStatsAsync();
  let slices = 0;
  while (timers.some((entry) => entry.delay === 0)) {
    for (const [key, col] of Object.entries(cols)) {
      col.push(key === 'x' || key === 'timestamps' ? col.length * 0.001 : key === 'voltage' ? 13 : 1);
    }
    state.chartWindow.max = cols.x.at(-1);
    state.chartWindow.min = state.chartWindow.max - 15;
    updateChartRange();
    assert.equal(getRangeStatsAsync(), task, 'natural follow growth must not restart this snapshot');
    const index = timers.findIndex((entry) => entry.delay === 0);
    timers.splice(index, 1)[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(++slices < 1000);
  }
  const result = await task;
  assert.ok(result);
  assert.equal(result.len, 25000);
  assert.equal(result.endIndex, 24999);
  assert.equal(document.getElementById('avg-voltage').textContent, '--');
  assert.equal(document.getElementById('avg-voltage').getAttribute('aria-busy'), 'true');
  updateStatsDisplay();
  assert.equal(document.getElementById('avg-voltage').textContent, (result.sumV / result.countV).toFixed(3));
  assert.match(document.getElementById('stats-snapshot-label').textContent, /统计范围.*更新中/);
  const latest = getRangeStatsAsync();
  await flushSlices();
  const final = await latest;
  assert.equal(final.endIndex, cols.x.length - 1);
  assert.equal(document.getElementById('avg-voltage').textContent, (final.sumV / final.countV).toFixed(3));
});
