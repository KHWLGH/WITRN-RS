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
const { getPdBufferLength, ingestPdData } = await import('../src/views/pd.js');

const meta = {
  raw: '0',
  bit_loc: null,
  field: 'GoodCRC',
  value: null,
};

test('PD capture follows recording state when enabled', () => {
  state.settings.pdFollowRecording = true;
  state.isRecording = false;
  const before = getPdBufferLength();
  ingestPdData(meta);
  assert.equal(getPdBufferLength(), before);

  state.isRecording = true;
  ingestPdData(meta);
  assert.equal(getPdBufferLength(), before + 1);
});

test('PD capture remains active when follow-recording is disabled', () => {
  state.settings.pdFollowRecording = false;
  state.isRecording = false;
  const before = getPdBufferLength();
  ingestPdData(meta);
  assert.equal(getPdBufferLength(), before + 1);
});
