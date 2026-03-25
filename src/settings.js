// @ts-check
/**
 * @file 设置持久化 — LazyStore 读写、settings 合并、UI 回显。
 */

import { state, defaultSettings, defaultAutoPauseSettings } from './state.js';
import { updateStatsDisplay } from './data.js';
import { updateTempUIVisibility } from './temperature.js';
import { rebuildRenderSeries, rebuildNavigatorSeries } from './chart.js';

// ─── Store singleton ─────────────────────────────────────────────────────────

/** @type {any} */
let settingsStore = null;

/** 正在加载时禁止自动保存 */
let isLoadingSettings = false;

/**
 * 获取 / 懒创建 LazyStore 实例。
 * @returns {Promise<any>}
 */
export async function getStore() {
  if (!settingsStore) {
    console.log('getStore: Creating new LazyStore...');
    const { LazyStore } = await import('./vendor/plugin-store.js');
    settingsStore = new LazyStore('settings.json', { autoSave: 500 });
    await settingsStore.init();
    console.log('getStore: LazyStore created and initialized');
  }
  return settingsStore;
}

// ─── Load ────────────────────────────────────────────────────────────────────

/** 从持久化存储加载设置并回显到 UI。 */
export async function loadSettings() {
  try {
    isLoadingSettings = true;
    console.log('loadSettings: Starting to load settings...');
    const store = await getStore();
    console.log('loadSettings: Store obtained:', store);
    const savedSettings = await store.get('appSettings');
    console.log('loadSettings: Saved settings from store:', savedSettings);

    if (savedSettings) {
      state.settings = { ...state.settings, ...savedSettings };
      console.log('loadSettings: Merged settings:', state.settings);

      // 基本控件
      const rateSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
      if (rateSelect) {
        rateSelect.value = String(state.settings.sampleRate);
        console.log('loadSettings: Set sample-rate to', state.settings.sampleRate);
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

      // Fill settings — fill state is derived from opacity (opacity > 0 means fill on)
      /** @param {string} id @param {number|undefined} val */
      const setOp = (id, val) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (el) el.value = String(val ?? 15);
      };

      setOp('opacity-voltage', state.settings.opacityVoltage);
      setOp('opacity-current', state.settings.opacityCurrent);
      setOp('opacity-power', state.settings.opacityPower);
      setOp('opacity-temp', state.settings.opacityTemp);

      // Derive fill state from opacity
      state.settings.fillVoltage = (state.settings.opacityVoltage ?? 15) > 0;
      state.settings.fillCurrent = (state.settings.opacityCurrent ?? 15) > 0;
      state.settings.fillPower   = (state.settings.opacityPower   ?? 15) > 0;
      state.settings.fillTemp    = (state.settings.opacityTemp    ?? 15) > 0;

      const statsRangeToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('stats-range-toggle'));
      if (statsRangeToggle) statsRangeToggle.checked = state.settings.statsRange;

      // Downsample settings
      const dsToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('downsample-toggle'));
      if (dsToggle) dsToggle.checked = state.settings.downsampleEnabled;
      const dsLevel = /** @type {HTMLSelectElement|null} */ (document.getElementById('downsample-level'));
      if (dsLevel) {
        dsLevel.value = state.settings.downsampleLevel;
        dsLevel.disabled = !state.settings.downsampleEnabled;
      }

      // Auto Pause
      if (savedSettings.autoPause) {
        state.autoPauseSettings = { ...state.autoPauseSettings, ...savedSettings.autoPause };
        console.log('loadSettings: autoPauseSettings after merge:', state.autoPauseSettings);
        const apToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('btn-auto-pause-toggle'));
        if (apToggle) {
          apToggle.checked = state.autoPauseSettings.enabled;
          console.log('loadSettings: Set apToggle.checked to', state.autoPauseSettings.enabled);
        } else {
          console.log('loadSettings: apToggle element not found!');
        }

        const apBasis = /** @type {HTMLSelectElement|null} */ (document.getElementById('ap-basis'));
        if (apBasis) {
          apBasis.value = state.autoPauseSettings.basis;
          console.log('loadSettings: Set apBasis.value to', state.autoPauseSettings.basis);
        }

        const apCondition = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-condition'));
        if (apCondition) {
          apCondition.value = String(state.autoPauseSettings.condition);
          console.log('loadSettings: Set apCondition.value to', state.autoPauseSettings.condition);
        }

        const apDuration = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-duration'));
        if (apDuration) {
          apDuration.value = String(state.autoPauseSettings.duration);
          console.log('loadSettings: Set apDuration.value to', state.autoPauseSettings.duration);
        }
      } else {
        console.log('loadSettings: No autoPause in settings');
      }

      console.log('loadSettings: Settings loaded successfully');
    } else {
      console.log('loadSettings: No saved settings found');
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  } finally {
    isLoadingSettings = false;
    console.log('loadSettings: Auto-save re-enabled');
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
    console.log('Settings saved successfully');
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
    console.log('debouncedSaveSettings: Skipped (loading in progress)');
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
    setOp2('opacity-power',   state.settings.opacityPower);
    setOp2('opacity-temp',    state.settings.opacityTemp);

    // Derive fill state from default opacity
    state.settings.fillVoltage = state.settings.opacityVoltage > 0;
    state.settings.fillCurrent = state.settings.opacityCurrent > 0;
    state.settings.fillPower   = state.settings.opacityPower   > 0;
    state.settings.fillTemp    = state.settings.opacityTemp    > 0;

    const statsRangeToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('stats-range-toggle'));
    if (statsRangeToggle) statsRangeToggle.checked = state.settings.statsRange;

    // Downsample settings
    const dsToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('downsample-toggle'));
    if (dsToggle) dsToggle.checked = state.settings.downsampleEnabled;
    const dsLevel = /** @type {HTMLSelectElement|null} */ (document.getElementById('downsample-level'));
    if (dsLevel) {
      dsLevel.value = state.settings.downsampleLevel;
      dsLevel.disabled = !state.settings.downsampleEnabled;
    }

    const apToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('btn-auto-pause-toggle'));
    if (apToggle) apToggle.checked = state.autoPauseSettings.enabled;

    const apBasis = /** @type {HTMLSelectElement|null} */ (document.getElementById('ap-basis'));
    if (apBasis) apBasis.value = state.autoPauseSettings.basis;

    const apCondition = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-condition'));
    if (apCondition) apCondition.value = String(state.autoPauseSettings.condition);

    const apDuration = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-duration'));
    if (apDuration) apDuration.value = String(state.autoPauseSettings.duration);

    // Update chart visibility
    if (state.mainChart) {
      state.mainChart.setDatasetVisibility(0, state.settings.showVoltage);
      state.mainChart.setDatasetVisibility(1, state.settings.showCurrent);
      state.mainChart.setDatasetVisibility(2, state.settings.showPower);
      if (state.mainChart.options?.scales) {
        state.mainChart.options.scales['y-voltage'].display = state.settings.showVoltage;
        state.mainChart.options.scales['y-current'].display = state.settings.showCurrent;
        state.mainChart.options.scales['y-power'].display = state.settings.showPower;
      }
      state.mainChart.update();
    }

    updateStatsDisplay();
    updateTempUIVisibility();

    // Rebuild chart data with reset downsample settings
    rebuildRenderSeries();
    rebuildNavigatorSeries();
    if (state.mainChart) state.mainChart.update('none');
    if (state.navigatorChart) state.navigatorChart.update('none');

    // Clear saved settings from store
    const store = await getStore();
    await store.delete('appSettings');
    await store.save();

    console.log('Settings reset to defaults');
  } catch (e) {
    console.error('Failed to reset settings:', e);
  }
}
