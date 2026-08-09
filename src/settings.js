// @ts-check
/**
 * @file 设置持久化 — LazyStore 读写、settings 合并、UI 回显。
 */

import { setSeriesFill, setSeriesVisible } from './chart.js';
import { updateStatsDisplay } from './data.js';
import { defaultAutoPauseSettings, defaultSettings, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';

// ─── Store singleton ─────────────────────────────────────────────────────────

/** @type {any} */
let settingsStore = null;

/** 正在加载时禁止自动保存 */
let isLoadingSettings = false;

/**
 * 仅接收已知且合理的设置值，避免手工编辑 settings.json 将畸形数据带入运行时。
 * @param {unknown} saved
 * @returns {import('./state.js').Settings}
 */
function normalizeSettings(saved) {
  const source = saved && typeof saved === 'object' ? /** @type {Record<string, unknown>} */ (saved) : {};
  const numberValue = (key, fallback, min, max) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const boolValue = (key, fallback) => (typeof source[key] === 'boolean' ? source[key] : fallback);
  const stringValue = (key, fallback) =>
    typeof source[key] === 'string' && source[key].trim() ? source[key] : fallback;

  return {
    rangeStart: numberValue('rangeStart', defaultSettings.rangeStart, 0, 1000),
    rangeEnd: numberValue('rangeEnd', defaultSettings.rangeEnd, 0, 1000),
    sampleRate: Math.round(numberValue('sampleRate', defaultSettings.sampleRate, 10, 60000)),
    showVoltage: boolValue('showVoltage', defaultSettings.showVoltage),
    showCurrent: boolValue('showCurrent', defaultSettings.showCurrent),
    showPower: boolValue('showPower', defaultSettings.showPower),
    showTemp: boolValue('showTemp', defaultSettings.showTemp),
    opacityVoltage: numberValue('opacityVoltage', defaultSettings.opacityVoltage, 0, 100),
    opacityCurrent: numberValue('opacityCurrent', defaultSettings.opacityCurrent, 0, 100),
    opacityPower: numberValue('opacityPower', defaultSettings.opacityPower, 0, 100),
    opacityTemp: numberValue('opacityTemp', defaultSettings.opacityTemp, 0, 100),
    statsRange: boolValue('statsRange', defaultSettings.statsRange),
    tempIp: stringValue('tempIp', defaultSettings.tempIp),
    tempPort: Math.round(numberValue('tempPort', defaultSettings.tempPort, 1, 65535)),
  };
}

/** @param {unknown} saved @returns {import('./state.js').AutoPauseSettings} */
function normalizeAutoPause(saved) {
  const source = saved && typeof saved === 'object' ? /** @type {Record<string, unknown>} */ (saved) : {};
  const condition = Number(source.condition);
  const duration = Number(source.duration);
  const basis = source.basis;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaultAutoPauseSettings.enabled,
    basis: basis === 'voltage' || basis === 'current' || basis === 'power' ? basis : 'none',
    condition: Number.isFinite(condition) ? condition : defaultAutoPauseSettings.condition,
    duration: Number.isFinite(duration) ? Math.max(0, duration) : defaultAutoPauseSettings.duration,
    triggerStartTime: null,
  };
}

/**
 * 获取 / 懒创建 LazyStore 实例。
 * @returns {Promise<any>}
 */
export async function getStore() {
  if (!settingsStore) {
    const { LazyStore } = await import('./vendor/plugin-store.js');
    settingsStore = new LazyStore('settings.json', { autoSave: 500 });
    await settingsStore.init();
  }
  return settingsStore;
}

// ─── Load ────────────────────────────────────────────────────────────────────

/** 从持久化存储加载设置并回显到 UI。 */
export async function loadSettings() {
  try {
    isLoadingSettings = true;
    const store = await getStore();
    const savedSettings = await store.get('appSettings');

    if (savedSettings) {
      state.settings = normalizeSettings(savedSettings);

      // 基本控件
      const rateSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
      if (rateSelect) {
        rateSelect.value = String(state.settings.sampleRate);
      }

      /** @param {string} id @param {boolean} val */
      const setChecked = (id, val) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (el) el.checked = val;
      };
      setChecked('show-voltage', state.settings.showVoltage);
      setChecked('show-current', state.settings.showCurrent);
      setChecked('show-power', state.settings.showPower);
      setChecked('show-temp', state.settings.showTemp);

      // Temperature service settings
      const tempIp = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
      if (tempIp) tempIp.value = state.settings.tempIp || '127.0.0.1';
      const tempPort = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
      if (tempPort) tempPort.value = String(state.settings.tempPort || 1573);

      // Fill settings are derived directly from opacity.
      /** @param {string} id @param {number|undefined} val */
      const setOp = (id, val) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (el) el.value = String(val ?? 15);
      };

      setOp('opacity-voltage', state.settings.opacityVoltage);
      setOp('opacity-current', state.settings.opacityCurrent);
      setOp('opacity-power', state.settings.opacityPower);
      setOp('opacity-temp', state.settings.opacityTemp);

      const statsRangeToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('stats-range-toggle'));
      if (statsRangeToggle) statsRangeToggle.checked = state.settings.statsRange;

      // Auto Pause
      if (savedSettings.autoPause) {
        state.autoPauseSettings = normalizeAutoPause(savedSettings.autoPause);
        const apToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('btn-auto-pause-toggle'));
        if (apToggle) {
          apToggle.checked = state.autoPauseSettings.enabled;
        }

        const apBasis = /** @type {HTMLSelectElement|null} */ (document.getElementById('ap-basis'));
        if (apBasis) {
          apBasis.value = state.autoPauseSettings.basis;
        }

        const apCondition = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-condition'));
        if (apCondition) {
          apCondition.value = String(state.autoPauseSettings.condition);
        }

        const apDuration = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-duration'));
        if (apDuration) {
          apDuration.value = String(state.autoPauseSettings.duration);
        }
      }
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  } finally {
    isLoadingSettings = false;
  }
}

// ─── Save ────────────────────────────────────────────────────────────────────

/** 将当前设置写入持久化存储。 */
export async function saveSettings() {
  try {
    const store = await getStore();
    const settingsToSave = {
      ...state.settings,
      autoPause: {
        enabled: state.autoPauseSettings.enabled,
        basis: state.autoPauseSettings.basis,
        condition: state.autoPauseSettings.condition,
        duration: state.autoPauseSettings.duration,
      },
    };
    await store.set('appSettings', settingsToSave);
    await store.save();
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// ─── Debounced save ──────────────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let __saveSettingsTimer = null;

/**
 * 防抖保存设置。
 * @param {number} [delay=500]
 */
export function debouncedSaveSettings(delay = 500) {
  if (isLoadingSettings) {
    return;
  }
  if (__saveSettingsTimer) {
    clearTimeout(__saveSettingsTimer);
  }
  __saveSettingsTimer = setTimeout(async () => {
    __saveSettingsTimer = null;
    await saveSettings();
  }, delay);
}

// ─── Reset ───────────────────────────────────────────────────────────────────

/** 恢复默认设置并更新 UI。 */
export async function resetSettings() {
  try {
    state.settings = { ...defaultSettings };
    state.autoPauseSettings = { ...defaultAutoPauseSettings, triggerStartTime: null };

    // Apply to UI
    const rateSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
    if (rateSelect) rateSelect.value = String(state.settings.sampleRate);

    /** @param {string} id @param {boolean} val */
    const setChecked = (id, val) => {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (el) el.checked = val;
    };
    setChecked('show-voltage', state.settings.showVoltage);
    setChecked('show-current', state.settings.showCurrent);
    setChecked('show-power', state.settings.showPower);
    setChecked('show-temp', state.settings.showTemp);

    const tempIp = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
    if (tempIp) tempIp.value = state.settings.tempIp;
    const tempPort = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
    if (tempPort) tempPort.value = String(state.settings.tempPort);

    // Opacity inputs
    /** @param {string} id @param {number} val */
    const setOp2 = (id, val) => {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (el) el.value = String(val);
    };
    setOp2('opacity-voltage', state.settings.opacityVoltage);
    setOp2('opacity-current', state.settings.opacityCurrent);
    setOp2('opacity-power', state.settings.opacityPower);
    setOp2('opacity-temp', state.settings.opacityTemp);

    const statsRangeToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('stats-range-toggle'));
    if (statsRangeToggle) statsRangeToggle.checked = state.settings.statsRange;

    const apToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('btn-auto-pause-toggle'));
    if (apToggle) apToggle.checked = state.autoPauseSettings.enabled;

    const apBasis = /** @type {HTMLSelectElement|null} */ (document.getElementById('ap-basis'));
    if (apBasis) apBasis.value = state.autoPauseSettings.basis;

    const apCondition = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-condition'));
    if (apCondition) apCondition.value = String(state.autoPauseSettings.condition);

    const apDuration = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-duration'));
    if (apDuration) apDuration.value = String(state.autoPauseSettings.duration);

    // Update chart visibility & fill (temp is handled by updateTempUIVisibility below)
    setSeriesVisible(0, state.settings.showVoltage);
    setSeriesVisible(1, state.settings.showCurrent);
    setSeriesVisible(2, state.settings.showPower);
    setSeriesFill(0, state.settings.opacityVoltage);
    setSeriesFill(1, state.settings.opacityCurrent);
    setSeriesFill(2, state.settings.opacityPower);
    setSeriesFill(3, state.settings.opacityTemp);

    updateStatsDisplay();
    updateTempUIVisibility();

    // Clear saved settings from store
    const store = await getStore();
    await store.delete('appSettings');
    await store.save();
  } catch (e) {
    console.error('Failed to reset settings:', e);
  }
}
