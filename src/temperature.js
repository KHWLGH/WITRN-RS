// @ts-check
/**
 * @file 温度服务连接管理及温度相关 UI 可见性控制。
 *
 * 来源二选一：本机（仪表 HID 温度）或外部 TCP。连/断仍只走命令栏按钮。
 */

import { setSeriesVisible } from './chart.js';
import { state } from './state.js';
import { syncTempUI } from './ui/controlbar.js';
import { toast } from './ui/toast.js';

const { invoke } = window.__TAURI__.core;

const DEVICE_HINT = '使用当前连接仪表报告的温度。使用命令栏按钮连接或断开。';
const EXTERNAL_HINT = '外部 TCP 温度服务，每行一个数值。使用命令栏按钮连接或断开。';

/** @returns {'device'|'external'} */
export function currentTempSource() {
  return state.settings.tempSource === 'device' ? 'device' : 'external';
}

/** 回显来源控件并显隐 IP/端口。 */
export function syncTempSourceUI() {
  const device = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-source-device'));
  const external = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-source-external'));
  const isDevice = currentTempSource() === 'device';
  if (device) device.checked = isDevice;
  if (external) external.checked = !isDevice;
  const fields = document.getElementById('temp-external-fields');
  if (fields) fields.hidden = isDevice;
  const hint = document.getElementById('temp-source-hint');
  if (hint) hint.textContent = isDevice ? DEVICE_HINT : EXTERNAL_HINT;
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────

/** 连接到温度服务（本机或 TCP）。 */
export async function connectTempService() {
  if (currentTempSource() === 'device') {
    if (!state.isConnected) {
      toast.warning('请先连接设备');
      return;
    }
    setTempConnected(true);
    return;
  }

  const ipEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
  const portEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
  const ip = ipEl?.value || '127.0.0.1';
  const port = Number.parseInt(portEl?.value || '', 10);

  try {
    await invoke('connect_temp_service', { ip, port });
    setTempConnected(true);
    state.settings.tempIp = ip;
    state.settings.tempPort = port;
  } catch (e) {
    toast.error(`温度服务连接失败: ${e}`);
  }
}

/** 断开温度服务。 */
export async function disconnectTempService() {
  if (currentTempSource() === 'device') {
    setTempConnected(false);
    return;
  }
  try {
    await invoke('disconnect_temp_service');
    setTempConnected(false);
  } catch (e) {
    toast.error(`断开温度服务失败: ${e}`);
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * 更新温度连接状态及 UI。
 * @param {boolean} connected
 */
export function setTempConnected(connected) {
  state.isTempConnected = connected;

  /** @param {string} id @param {boolean} disabled */
  const setDisabled = (id, disabled) => {
    const el = /** @type {HTMLButtonElement|HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.disabled = disabled;
  };

  setDisabled('temp-ip', connected);
  setDisabled('temp-port', connected);
  setDisabled('temp-source-device', connected);
  setDisabled('temp-source-external', connected);
  syncTempUI(connected);

  if (connected) {
    state.hasTempData = true;
  }

  if (!connected) {
    state.currentTemp = null;
    const rtTemp = document.getElementById('rt-temp');
    if (rtTemp) rtTemp.textContent = '--';
  }

  updateTempUIVisibility();
}

// ─── UI visibility ───────────────────────────────────────────────────────────

/** 根据当前是否有温度数据来显示/隐藏温度相关的 UI 元素。 */
export function updateTempUIVisibility() {
  const showTemp = state.isTempConnected || state.hasTempData;

  const tempCard = document.getElementById('temp-card');
  if (tempCard) tempCard.style.display = showTemp ? 'flex' : 'none';

  const exportWithTemp = document.getElementById('export-with-temp');
  if (exportWithTemp) exportWithTemp.classList.toggle('hidden', !showTemp);

  const showTempContainer = document.getElementById('show-temp-container');
  if (showTempContainer) showTempContainer.style.display = showTemp ? 'flex' : 'none';

  if (state.mainChart) {
    const tempVisible = showTemp && state.settings.showTemp;
    setSeriesVisible(3, tempVisible);
  }
}
