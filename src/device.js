// @ts-check
/**
 * @file HID 设备枚举、连接、断开。
 */

import { refreshRecordButton, stopRecording } from './data.js';
import { deviceStream } from './device-stream.js';
import { state } from './state.js';
import { resetTempForDevice } from './temperature.js';
import { toast } from './ui/toast.js';

const { invoke } = window.__TAURI__.core;

/** @type {Promise<() => void>|null} */
let streamInitialization = null;

/** Call once at app startup, before a device can connect. PD listeners remain in app.js. */
export function initializeDeviceStream() {
  if (streamInitialization) return streamInitialization;
  deviceStream.configure({
    onEnd: () => setConnected(false),
    onError: (error) => {
      // 三个 onError 调用点都是终态：流已经不会再有数据了。
      // 只停记录不改连接状态的话，底栏会永远停在「已连接」盖着一条死流。
      // setConnected(false) 内部已含 stopRecording 与广播，这里不再单独停。
      setConnected(false);
      toast.error(`采集已停止: ${error.error}`);
    },
  });
  deviceStream.enable();
  // 发版验收要的是"应用自己看到的数字"，不是人转述的数字：`scripts/verify-hardware-receipt.mjs`
  // 的回执里那两个 declared 字段就是从这里的返回值读的。只读，不影响采集路径。
  window.__WITRN_STREAM__ = () => deviceStream.diagnostics();
  streamInitialization = (async () => {
    const { listen } = window.__TAURI__.event;
    const unlisten = [];
    try {
      unlisten.push(await listen('device-stream-open', (event) => deviceStream.open(event.payload)));
      unlisten.push(await listen('device-data-batch', (event) => deviceStream.handleBatch(event.payload)));
      unlisten.push(await listen('stream-error', (event) => deviceStream.handleError(event.payload)));
      unlisten.push(await listen('device-stream-end', (event) => deviceStream.handleEnd(event.payload)));
      return () => {
        for (const stop of unlisten) stop();
        streamInitialization = null;
      };
    } catch (error) {
      for (const stop of unlisten) stop();
      streamInitialization = null;
      throw error;
    }
  })();
  return streamInitialization;
}

/** Replaces app.js invoke('shutdown'); rejects rather than destroy with a missing tail. */
export async function shutdownDeviceStream() {
  await initializeDeviceStream();
  await deviceStream.shutdown();
}

/** @param {string} id @param {string} value */
function setDeviceField(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ─── Device enumeration ──────────────────────────────────────────────────────

/**
 * 枚举所有已知 HID 设备并更新下拉列表。
 * @returns {Promise<import('./state.js').DeviceInfo[]>}
 */
export async function refreshDeviceList() {
  try {
    state.deviceList = await invoke('enumerate_devices');
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('device-select'));

    select.innerHTML = '';

    const previousPath = state.selectedDevicePath;

    if (state.deviceList.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '-- 未检测到设备 --';
      select.appendChild(option);
      state.selectedDevicePath = null;
    } else {
      state.deviceList.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.path;
        option.textContent = device.display_name;
        option.dataset.vid = String(device.vid);
        option.dataset.pid = String(device.pid);
        option.dataset.sn = device.serial_number || '';
        option.dataset.model = device.model_name;
        select.appendChild(option);
      });

      const keepIndex = previousPath ? state.deviceList.findIndex((d) => d.path === previousPath) : -1;
      select.selectedIndex = keepIndex >= 0 ? keepIndex : 0;
      onDeviceSelect();
    }

    return state.deviceList;
  } catch (e) {
    console.error('枚举设备失败:', e);
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('device-select'));
    select.innerHTML = '<option value="">-- 枚举设备失败 --</option>';
    return [];
  }
}

// ─── Device selection ────────────────────────────────────────────────────────

/** 处理设备下拉框选中变化。 */
export function onDeviceSelect() {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById('device-select'));
  const selectedOption = select.options[select.selectedIndex];

  if (selectedOption?.value) {
    state.selectedDevicePath = selectedOption.value;
    const vid = selectedOption.dataset.vid || '0';
    const pid = selectedOption.dataset.pid || '0';
    const sn = selectedOption.dataset.sn || '--';

    setDeviceField('device-vid', `0x${Number(vid).toString(16).toUpperCase().padStart(4, '0')}`);
    setDeviceField('device-pid', `0x${Number(pid).toString(16).toUpperCase().padStart(4, '0')}`);
    setDeviceField('device-sn', sn || '--');
  } else {
    state.selectedDevicePath = null;
    setDeviceField('device-vid', '--');
    setDeviceField('device-pid', '--');
    setDeviceField('device-sn', '--');
  }
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────

/** @type {boolean} */
let connecting = false;

/** 连接到当前选中的设备。 */
export async function connectDevice() {
  if (connecting) return;
  try {
    if (!state.selectedDevicePath) {
      toast.warning('请先选择一个设备');
      return;
    }
    connecting = true;
    await initializeDeviceStream();
    if (deviceStream.generation) await deviceStream.drain();
    const stream = await invoke('connect_device_by_path', { path: state.selectedDevicePath });
    deviceStream.open(stream);

    // 获取连接后的设备信息
    const deviceInfo = await invoke('get_current_device_info');
    if (deviceInfo) {
      const di = /** @type {import('./state.js').DeviceInfo} */ (deviceInfo);
      setDeviceField('device-vid', `0x${di.vid.toString(16).toUpperCase().padStart(4, '0')}`);
      setDeviceField('device-pid', `0x${di.pid.toString(16).toUpperCase().padStart(4, '0')}`);
      setDeviceField('device-sn', di.serial_number || '--');
    }

    if (deviceStream.ended) throw new Error('设备已在连接过程中断开');
    setConnected(true);

    try {
      await invoke('set_sample_rate', { rate: state.settings.sampleRate, generation: deviceStream.generation });
    } catch (err) {
      console.error('Failed to apply sample rate on connect:', err);
    }
  } catch (e) {
    toast.error(`连接失败: ${e}`);
  } finally {
    connecting = false;
  }
}

/** 断开当前设备连接。 */
export async function disconnectDevice() {
  try {
    await deviceStream.drain();
    setConnected(false);
  } catch (e) {
    toast.error(`断开失败: ${e}`);
  }
}

/**
 * 更新连接状态 UI。
 * @param {boolean} connected
 */
export function setConnected(connected) {
  state.isConnected = connected;

  const statusEl = document.getElementById('connection-status');
  if (statusEl) statusEl.classList.toggle('connected', connected);

  const textEl = document.getElementById('connection-text');
  if (textEl) textEl.textContent = connected ? '已连接' : '未连接';

  /** @param {string} id @param {boolean} disabled */
  const setDisabled = (id, disabled) => {
    const el = /** @type {HTMLButtonElement|HTMLSelectElement|null} */ (document.getElementById(id));
    if (el) el.disabled = disabled;
  };

  setDisabled('btn-connect', false);
  setDisabled('device-select', connected);
  setDisabled('btn-refresh-devices', connected);

  const connectBtn = document.getElementById('btn-connect');
  const connectLabel = document.getElementById('btn-connect-label');
  const connectIcon = document.getElementById('btn-connect-icon');
  if (connectBtn) {
    connectBtn.title = connected ? '断开连接' : '连接设备';
    connectBtn.setAttribute('aria-label', connectBtn.title);
  }
  if (connectLabel) connectLabel.textContent = connected ? '断开' : '连接';
  if (connectIcon) {
    connectIcon.classList.toggle('fi-plug', !connected);
    connectIcon.classList.toggle('fi-plug-off', connected);
  }

  refreshRecordButton();

  if (!connected) {
    state.__markPdDisconnect?.();
    resetTempForDevice();
  }

  if (!connected) {
    const wasRecording = state.isRecording;
    void stopRecording({ discard: true }).catch(() => {});
    if (wasRecording) return; // stopRecording 已广播
  }

  // PD 视图的采集按钮在「跟随记录」开启时就是记录开关，未连接时要禁用 —— 连接
  // 状态变化同样要广播（stopRecording 只覆盖「拔设备时正在记录」这一种情况）
  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
}
