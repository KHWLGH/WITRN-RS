import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 「跟随记录」开启时，PD 清空与监控清空互相联动。
 * node 环境没有 HTMLDialogElement，ui/dialog.js 的 ask 会回退到 __TAURI__.dialog.ask，
 * 因此这里 stub 它即可跑通真实的确认路径，并顺带断言弹窗文案说清了联动后果。
 */

/** @type {string[]} */
const asked = [];
let answer = true;

globalThis.window = {
  __TAURI__: {
    core: { invoke: async () => null },
    dialog: {
      ask: async (/** @type {string} */ text) => {
        asked.push(text);
        return answer;
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

const { state } = await import('../src/state.js');
const { clearPdEntries, getPdBufferLength, ingestPdData, requestPdClear } = await import('../src/views/pd.js');

const meta = { raw: '0', bit_loc: null, field: 'GoodCRC', value: null };

/** 灌入 n 条报文（跟随关闭时不受记录状态影响），并复位联动探针。 */
function seed(n) {
  state.settings.pdFollowRecording = false;
  state.isRecording = false;
  clearPdEntries();
  for (let i = 0; i < n; i++) ingestPdData(meta);
  asked.length = 0;
  answer = true;
  monitorCleared = 0;
  state.__clearMonitorData = () => {
    monitorCleared++;
  };
}

let monitorCleared = 0;

test('跟随关闭时 PD 清空只清自己', async () => {
  seed(3);
  assert.equal(getPdBufferLength(), 3);

  await requestPdClear();

  assert.equal(getPdBufferLength(), 0);
  assert.equal(monitorCleared, 0, '未开启跟随记录时不应波及监控数据');
  assert.equal(asked.length, 1);
  assert.ok(!asked[0].includes('跟随记录'), `独立清空的文案不应提联动: ${asked[0]}`);
});

test('跟随开启时 PD 清空同时重置监控，且弹窗说明联动', async () => {
  seed(3);
  state.settings.pdFollowRecording = true;

  await requestPdClear();

  assert.equal(getPdBufferLength(), 0);
  assert.equal(monitorCleared, 1, '开启跟随记录时应级联清空监控数据');
  assert.match(asked[0], /跟随记录已开启/);
  assert.match(asked[0], /监控图表/);
});

test('取消确认时两侧都不动', async () => {
  seed(2);
  state.settings.pdFollowRecording = true;
  answer = false;

  await requestPdClear();

  assert.equal(getPdBufferLength(), 2);
  assert.equal(monitorCleared, 0);
});

test('两侧都无内容时不弹确认框', async () => {
  seed(0);
  await requestPdClear();
  assert.equal(asked.length, 0, '缓冲为空且未跟随时应直接返回');

  // 跟随开启时监控侧可能仍有数据，即使报文为空也要确认
  state.settings.pdFollowRecording = true;
  await requestPdClear();
  assert.equal(asked.length, 1);
  assert.equal(monitorCleared, 1);
});

test('clearPdEntries 是无级联的纯清空（供监控侧反向调用）', async () => {
  seed(4);
  state.settings.pdFollowRecording = true;

  clearPdEntries();

  assert.equal(getPdBufferLength(), 0);
  assert.equal(monitorCleared, 0, '纯清空不得回调监控，否则两侧会互相递归');
  assert.equal(asked.length, 0);
});
