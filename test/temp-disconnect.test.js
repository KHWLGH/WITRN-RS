import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        title: '',
        style: {},
        classList: { toggle() {} },
        setAttribute() {},
      });
    }
    return elements.get(id);
  },
  dispatchEvent: () => true,
};

const { state } = await import('../src/state.js');
const { setTempConnected } = await import('../src/temperature.js');
const { setConnected } = await import('../src/device.js');
const { toast } = await import('../src/ui/toast.js');

const toastCalls = [];
toast.success = () => toastCalls.push('success');
toast.error = () => toastCalls.push('error');
toast.warning = () => toastCalls.push('warning');

function resetTempDisconnectState(source) {
  state.isConnected = true;
  state.isRecording = false;
  state.recordingStartTime = null;
  state.settings.tempSource = source;
  state.isTempConnected = false;
  state.hasTempData = false;
  state.currentTemp = null;
  toastCalls.length = 0;
}

test('unplugging the meter disconnects the device temperature source', async () => {
  resetTempDisconnectState('device');
  setTempConnected(true);
  state.currentTemp = 42;
  document.getElementById('rt-temp').textContent = '42.0';

  await setConnected(false);

  assert.equal(state.isTempConnected, false, 'the 本机 temperature source dies with the meter');
  assert.equal(state.currentTemp, null);
  assert.equal(document.getElementById('rt-temp').textContent, '--');
  assert.equal(document.getElementById('temp-source-device').disabled, false, '来源单选必须重新可用');
  assert.equal(document.getElementById('temp-ip').disabled, false);
});

test('an external temperature service survives an HID disconnect', async () => {
  resetTempDisconnectState('external');
  setTempConnected(true);
  state.currentTemp = 42;

  await setConnected(false);

  assert.equal(state.isTempConnected, true, 'TCP 温度会话与仪表流相互独立');
  assert.equal(state.currentTemp, 42);
});

test('the device-source reset is silent and keeps recorded temperature data', async () => {
  resetTempDisconnectState('device');
  setTempConnected(true);
  assert.equal(state.hasTempData, true);
  toastCalls.length = 0;

  await setConnected(false);

  assert.deepEqual(toastCalls, [], '被动注销不是用户操作失败，不该弹提示');
  assert.equal(state.hasTempData, true, '已记录的温度曲线不能被这次重置一起藏掉');
});
