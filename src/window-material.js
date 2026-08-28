// @ts-check
/**
 * @file Win11 Mica 窗口材质桥：查询可用性、同步深浅色、设置开关。
 */

import { state } from './state.js';

/** @param {string} cmd @param {Record<string, unknown>} [args] */
function invokeCmd(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return Promise.resolve(null);
  return invoke(cmd, args);
}

function resolvedDark() {
  return document.documentElement?.getAttribute('data-theme') !== 'light';
}

/**
 * @param {boolean} applied
 */
function setBackdrop(applied) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (applied) document.documentElement.setAttribute('data-backdrop', 'mica');
  else document.documentElement.removeAttribute('data-backdrop');
}

function echoWindowMaterialUI() {
  const available = state.windowMaterialAvailable;
  const micaOn = available && state.settings.windowMaterial;
  const row = document.getElementById('window-material-row');
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('window-material'));
  const unfocusedRow = document.getElementById('window-material-unfocused-row');
  const unfocusedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('window-material-unfocused'));
  if (row) row.hidden = !available;
  if (input) input.checked = state.settings.windowMaterial;
  if (unfocusedRow) {
    unfocusedRow.hidden = !available;
    unfocusedRow.classList.toggle('is-disabled', !micaOn);
  }
  if (unfocusedInput) {
    unfocusedInput.checked = state.settings.windowMaterialUnfocused;
    unfocusedInput.disabled = !micaOn;
  }
}

async function pushUnfocusedPreference() {
  if (!state.windowMaterialAvailable) return;
  try {
    await invokeCmd('set_window_material_unfocused', {
      enabled: !!state.settings.windowMaterialUnfocused,
    });
  } catch (error) {
    console.error('切换非聚焦窗口材质失败:', error);
  }
}

/**
 * 启动时询问后端材质状态，并按用户偏好开/关。
 * @returns {Promise<void>}
 */
export async function initWindowMaterial() {
  try {
    const info = /** @type {{ available: boolean, applied: boolean }|null} */ (await invokeCmd('get_window_material'));
    state.windowMaterialAvailable = !!info?.available;
    if (!state.windowMaterialAvailable) {
      state.settings.windowMaterial = false;
      setBackdrop(false);
      echoWindowMaterialUI();
      return;
    }
    const want = state.settings.windowMaterial !== false;
    state.settings.windowMaterial = want;
    if (want !== !!info?.applied) {
      const next = /** @type {{ available: boolean, applied: boolean }|null} */ (
        await invokeCmd('set_window_material_enabled', { enabled: want, dark: resolvedDark() })
      );
      setBackdrop(!!next?.applied);
    } else {
      setBackdrop(want);
      if (want) await invokeCmd('set_window_material_theme', { dark: resolvedDark() });
    }
    await pushUnfocusedPreference();
  } catch (error) {
    console.error('窗口材质初始化失败:', error);
    state.windowMaterialAvailable = false;
    setBackdrop(false);
  }
  echoWindowMaterialUI();
}

/** 主题切换后同步 Mica 深/浅。 */
export async function syncWindowMaterialTheme() {
  if (!state.windowMaterialAvailable || !state.settings.windowMaterial) return;
  try {
    await invokeCmd('set_window_material_theme', { dark: resolvedDark() });
  } catch (error) {
    console.error('窗口材质主题同步失败:', error);
  }
}

/**
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function setWindowMaterialEnabled(enabled) {
  state.settings.windowMaterial = enabled;
  if (!state.windowMaterialAvailable) {
    setBackdrop(false);
    echoWindowMaterialUI();
    return;
  }
  try {
    const next = /** @type {{ available: boolean, applied: boolean }|null} */ (
      await invokeCmd('set_window_material_enabled', { enabled, dark: resolvedDark() })
    );
    setBackdrop(!!next?.applied);
  } catch (error) {
    console.error('切换窗口材质失败:', error);
    setBackdrop(false);
  }
  echoWindowMaterialUI();
}

/**
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function setWindowMaterialUnfocused(enabled) {
  state.settings.windowMaterialUnfocused = enabled;
  await pushUnfocusedPreference();
  echoWindowMaterialUI();
}

export { echoWindowMaterialUI };
