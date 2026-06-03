// @ts-check
/**
 * @file HID 设备枚举、连接、断开。
 */

import { stopRecording } from './data.js';
import { state } from './state.js';

const { invoke } = window.__TAURI__.core;

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

      if (state.deviceList.length > 0) {
        select.selectedIndex = 0;
        onDeviceSelect();
      }
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

    const vidEl = /** @type {HTMLInputElement} */ (document.getElementById('device-vid'));
    const pidEl = /** @type {HTMLInputElement} */ (document.getElementById('device-pid'));
    const snEl = /** @type {HTMLInputElement} */ (document.getElementById('device-sn'));
    vidEl.value = `0x${Number(vid).toString(16).toUpperCase().padStart(4, '0')}`;
    pidEl.value = `0x${Number(pid).toString(16).toUpperCase().padStart(4, '0')}`;
    snEl.value = sn || '--';
  } else {
    state.selectedDevicePath = null;
    const vidEl = /** @type {HTMLInputElement} */ (document.getElementById('device-vid'));
    const pidEl = /** @type {HTMLInputElement} */ (document.getElementById('device-pid'));
    const snEl = /** @type {HTMLInputElement} */ (document.getElementById('device-sn'));
    vidEl.value = '--';
    pidEl.value = '--';
    snEl.value = '--';
  }
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────

/** 连接到当前选中的设备。 */
export async function connectDevice() {
  try {
    if (state.selectedDevicePath) {
      await invoke('connect_device_by_path', { path: state.selectedDevicePath });
    } else {
      const vidStr = /** @type {HTMLInputElement} */ (document.getElementById('device-vid')).value;
      const pidStr = /** @type {HTMLInputElement} */ (document.getElementById('device-pid')).value;
      const vid = Number(vidStr.trim());
      const pid = Number(pidStr.trim());

      if (Number.isNaN(vid) || Number.isNaN(pid)) {
        alert('请先选择一个设备或输入有效的VID/PID');
        return;
      }

      await invoke('connect_device', { vid, pid });
    }

    // 获取连接后的设备信息
    const deviceInfo = await invoke('get_current_device_info');
    if (deviceInfo) {
      const di = /** @type {import('./state.js').DeviceInfo} */ (deviceInfo);
      /** @type {HTMLInputElement} */ (document.getElementById('device-vid')).value =
        `0x${di.vid.toString(16).toUpperCase().padStart(4, '0')}`;
      /** @type {HTMLInputElement} */ (document.getElementById('device-pid')).value =
        `0x${di.pid.toString(16).toUpperCase().padStart(4, '0')}`;
      /** @type {HTMLInputElement} */ (document.getElementById('device-sn')).value = di.serial_number || '--';
      const nameEl = document.getElementById('device-name-text');
      if (nameEl) nameEl.textContent = di.model_name;
    }

    setConnected(true);

    try {
      await invoke('set_sample_rate', { rate: state.settings.sampleRate });
    } catch (err) {
      console.error('Failed to apply sample rate on connect:', err);
    }
  } catch (e) {
    alert('连接失败: ' + e);
  }
}

/** 断开当前设备连接。 */
export async function disconnectDevice() {
  try {
    await invoke('disconnect_device');
    setConnected(false);
    const nameEl = document.getElementById('device-name-text');
    if (nameEl) nameEl.textContent = '--';
  } catch (e) {
    alert('断开失败: ' + e);
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

  setDisabled('btn-connect', connected);
  setDisabled('btn-disconnect', !connected);
  setDisabled('btn-start-record', !connected);
  setDisabled('device-select', connected);
  setDisabled('btn-refresh-devices', connected);

  if (!connected && state.isRecording) {
    stopRecording();
  }
}
