import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map([
  ['view-pd', { hidden: true }],
  ['pd-counter', { textContent: '' }],
]);
globalThis.document = {
  getElementById(id) {
    return elements.get(id) ?? null;
  },
};

const { state } = await import('../src/state.js');
const { getPdBufferLength, getPdCaptureState, ingestPdData } = await import('../src/views/pd.js');

const meta = { raw: '0', bit_loc: null, field: 'GoodCRC', value: null };

test('capture state reflects follow-recording and recording combinations', () => {
  state.settings.pdFollowRecording = true;
  state.isRecording = false;
  assert.deepEqual(getPdCaptureState(), { paused: false, followSuspended: true, capturing: false });

  state.isRecording = true;
  assert.deepEqual(getPdCaptureState(), { paused: false, followSuspended: false, capturing: true });

  state.settings.pdFollowRecording = false;
  state.isRecording = false;
  assert.deepEqual(getPdCaptureState(), { paused: false, followSuspended: false, capturing: true });
});

test('ingest gating matches the followSuspended flag', () => {
  state.settings.pdFollowRecording = true;
  state.isRecording = false;
  assert.equal(getPdCaptureState().followSuspended, true);
  const before = getPdBufferLength();
  ingestPdData(meta);
  assert.equal(getPdBufferLength(), before, 'suspended capture must drop the message');

  state.isRecording = true;
  assert.equal(getPdCaptureState().followSuspended, false);
  ingestPdData(meta);
  assert.equal(getPdBufferLength(), before + 1, 'live capture must buffer the message');
});
