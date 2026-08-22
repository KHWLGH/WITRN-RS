import assert from 'node:assert/strict';
import test from 'node:test';

const invokeCalls = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'pd_log_after') return [];
        return null;
      },
    },
  },
};

const elements = new Map([
  ['view-pd', { hidden: true }],
  ['pd-counter', { textContent: '' }],
]);
globalThis.document = {
  getElementById(id) {
    return elements.get(id) ?? null;
  },
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 0;
};

const { state } = await import('../src/state.js');
const { getPdBufferLength, ingestPdBatch, ingestPdData, syncPdView } = await import('../src/views/pd.js');

function compact(seq, type = 'GoodCRC') {
  return { t: 1_000 + seq, seq, sop: 'SOP', type, role: 'SNK', summary: '' };
}

test('ingestPdBatch writes every payload and only syncs once while hidden', () => {
  state.settings.pdFollowRecording = false;
  const before = getPdBufferLength();
  ingestPdBatch([compact(1), compact(2), compact(3)]);
  assert.equal(getPdBufferLength(), before + 3);
});

test('duplicate seq is ignored so gap-fill cannot double-count', () => {
  state.settings.pdFollowRecording = false;
  ingestPdData(compact(10));
  const before = getPdBufferLength();
  ingestPdBatch([compact(10), compact(11)]);
  assert.equal(getPdBufferLength(), before + 1);
});

test('syncPdView asks the backend for events after the last seq', async () => {
  state.settings.pdFollowRecording = false;
  ingestPdData(compact(20));
  invokeCalls.length = 0;
  syncPdView();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(invokeCalls.some((call) => call.cmd === 'pd_log_after' && call.args?.afterSeq === 20));
});
