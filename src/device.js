// @ts-check
/**
 * @file HID 设备枚举、连接、断开。
 */

import { refreshRecordButton, stopRecording } from './data.js';
import { state } from './state.js';
import { toast } from './ui/toast.js';
import { refreshDeviceIdentifyState } from './views/device.js';

const { invoke } = window.__TAURI__.core;

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

/** 连接到当前选中的设备。 */
export async function connectDevice() {
  try {
    if (!state.selectedDevicePath) {
      toast.warning('请先选择一个设备');
      return;
    }
    await invoke('connect_device_by_path', { path: state.selectedDevicePath });

    // 获取连接后的设备信息
    const deviceInfo = await invoke('get_current_device_info');
    if (deviceInfo) {
      const di = /** @type {import('./state.js').DeviceInfo} */ (deviceInfo);
      setDeviceField('device-vid', `0x${di.vid.toString(16).toUpperCase().padStart(4, '0')}`);
      setDeviceField('device-pid', `0x${di.pid.toString(16).toUpperCase().padStart(4, '0')}`);
      setDeviceField('device-sn', di.serial_number || '--');
    }

    setConnected(true);

    try {
      await invoke('set_sample_rate', { rate: state.settings.sampleRate });
    } catch (err) {
      console.error('Failed to apply sample rate on connect:', err);
    }
  } catch (e) {
    toast.error(`连接失败: ${e}`);
  }
}

/** 断开当前设备连接。 */
export async function disconnectDevice() {
  try {
    await invoke('disconnect_device');
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
  refreshDeviceIdentifyState();

  if (!connected) {
    state.__markPdDisconnect?.();
  }

  if (!connected && state.isRecording) {
    stopRecording();
    return; // stopRecording 已广播
  }

  // PD 视图的采集按钮在「跟随记录」开启时就是记录开关，未连接时要禁用 —— 连接
  // 状态变化同样要广播（stopRecording 只覆盖「拔设备时正在记录」这一种情况）
  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
}
