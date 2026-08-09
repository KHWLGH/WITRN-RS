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
      elements.set(id, { textContent: '', disabled: false });
    }
    return elements.get(id);
  },
};

const { state } = await import('../src/state.js');
const { startRecording, stopRecording } = await import('../src/data.js');

function resetRecordingState() {
  state.isConnected = true;
  state.isRecording = false;
  state.recordingStartTime = null;
  state.recordingBaseSeconds = 0;
  state.lastRecordingStartTime = null;
  state.chartData = { timestamps: [], voltage: [], current: [], power: [], temp: [] };
  state.chartSeries = { x: [], voltage: [], current: [], power: [], temp: [] };
  state.energy = { wh: 12, mah: 34, lastTimestamp: 1234 };
  state.autoPauseSettings.triggerStartTime = 5678;
}

test('recording session boundaries reset integration and auto-pause baselines', () => {
  resetRecordingState();

  startRecording();
  assert.equal(state.isRecording, true);
  assert.equal(state.energy.lastTimestamp, null);
  assert.equal(state.autoPauseSettings.triggerStartTime, null);

  state.energy.lastTimestamp = 9999;
  state.autoPauseSettings.triggerStartTime = 9999;
  stopRecording();
  assert.equal(state.isRecording, false);
  assert.equal(state.energy.lastTimestamp, null);
  assert.equal(state.autoPauseSettings.triggerStartTime, null);
});

test('recording after an import continues from the last relative x value', () => {
  resetRecordingState();
  state.chartData.timestamps = [1_000_000, 2_000_000];
  state.chartSeries.x = [3723.5, 3724.5];
  state.settings.sampleRate = 250;

  startRecording();
  assert.equal(state.recordingBaseSeconds, 3724.75);
  stopRecording();
});
