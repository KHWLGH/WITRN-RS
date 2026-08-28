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
        classList: { toggle() {} },
        setAttribute() {},
      });
    }
    return elements.get(id);
  },
};

const { emptyChartColumns, setChartColumns, state } = await import('../src/state.js');
const { startRecording, stopRecording, updateChartRange } = await import('../src/data.js');

function resetRecordingState() {
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

test('updateChartRange follow keeps duration as lastX grows', () => {
  resetRecordingState();
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ts = xs.map((x) => x * 1000);
  state.chartSeries.x.set(xs);
  state.chartSeries.timestamps.set(ts);
  state.chartWindow = { mode: 'follow', duration: 4, min: 6, max: 10 };

  updateChartRange();
  assert.equal(state.chartWindow.mode, 'follow');
  assert.equal(state.chartWindow.min, 6);
  assert.equal(state.chartWindow.max, 10);

  state.chartSeries.x.push(20);
  state.chartSeries.timestamps.push(20_000);
  updateChartRange();
  assert.equal(state.chartWindow.mode, 'follow');
  assert.equal(state.chartWindow.duration, 4);
  assert.equal(state.chartWindow.max, 20);
  assert.equal(state.chartWindow.min, 16);
});
