// @ts-check
/**
 * @file 温度服务连接管理及温度相关 UI 可见性控制。
 */

import { state } from './state.js';

const { invoke } = window.__TAURI__.core;

// ─── Connect / Disconnect ────────────────────────────────────────────────────

/** 连接到温度服务（TCP）。 */
export async function connectTempService() {
  const ipEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
  const portEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
  const ip = ipEl?.value || '127.0.0.1';
  const port = parseInt(portEl?.value || '1573') || 1573;

  try {
    await invoke('connect_temp_service', { ip, port });
    setTempConnected(true);
    state.settings.tempIp = ip;
    state.settings.tempPort = port;
  } catch (e) {
    alert('温度服务连接失败: ' + e);
  }
}

/** 断开温度服务。 */
export async function disconnectTempService() {
  try {
    await invoke('disconnect_temp_service');
    setTempConnected(false);
  } catch (e) {
    alert('断开温度服务失败: ' + e);
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * 更新温度连接状态及 UI。
 * @param {boolean} connected
 */
export function setTempConnected(connected) {
  state.isTempConnected = connected;

  const statusEl = document.getElementById('temp-connection-status');
  if (statusEl) statusEl.classList.toggle('connected', connected);

  const textEl = document.getElementById('temp-connection-text');
  if (textEl) textEl.textContent = connected ? '已连接' : '未连接';

  /** @param {string} id @param {boolean} disabled */
  const setDisabled = (id, disabled) => {
    const el = /** @type {HTMLButtonElement|HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.disabled = disabled;
  };

  setDisabled('btn-temp-connect', connected);
  setDisabled('btn-temp-disconnect', !connected);
  setDisabled('temp-ip', connected);
  setDisabled('temp-port', connected);

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
  if (showTempContainer) showTempContainer.style.display = showTemp ? 'inline-block' : 'none';

  const fillTempContainer = document.getElementById('fill-temp-container');
  if (fillTempContainer) fillTempContainer.style.display = showTemp ? 'flex' : 'none';

  if (state.mainChart?.data?.datasets?.[3]) {
    const tempVisible = showTemp && state.settings.showTemp;
    state.mainChart.setDatasetVisibility(3, tempVisible);
    if (state.mainChart.options?.scales?.['y-temp']) {
      state.mainChart.options.scales['y-temp'].display = tempVisible;
    }
    state.mainChart.update('none');
  }
}
