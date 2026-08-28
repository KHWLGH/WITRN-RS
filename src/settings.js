// @ts-check
/**
 * @file 设置持久化 — LazyStore 读写、settings 合并、UI 回显。
 */

import { refreshChartScales, setSeriesFill, setSeriesVisible } from './chart.js';
import { updateEnergyDisplay, updateSampleRateStatus, updateSliderFill, updateStatsDisplay } from './data.js';
import { defaultAutoPauseSettings, defaultSettings, state } from './state.js';
import { syncTempSourceUI, updateTempUIVisibility } from './temperature.js';
import { applyThemePreference, echoThemeUI } from './theme.js';
import { syncAutoPauseUI } from './ui/controlbar.js';
import { applyUiScale, clampUiScalePercent, fillUiScaleHint } from './ui-scale.js';
import { setSampleRateOption } from './utils.js';
import { echoWindowMaterialUI, setWindowMaterialEnabled } from './window-material.js';

// ─── Store singleton ─────────────────────────────────────────────────────────

/** @type {any} */
let settingsStore = null;

/** 正在加载时禁止自动保存 */
let isLoadingSettings = false;

/**
 * 合并已保存的设置。只对参与索引计算或直接下发后端的数值字段钳位；
 * 其余字段即使被手工改坏也仅影响显示，不做逐字段校验。
 * @param {unknown} saved
 * @returns {import('./state.js').Settings}
 */
function normalizeSettings(saved) {
  const source = /** @type {Partial<import('./state.js').Settings>} */ (
    saved && typeof saved === 'object' ? saved : {}
  );
  const merged = { ...defaultSettings, ...source };

  /** @param {number} value @param {number} min @param {number} max @param {number} fallback */
  const clamp = (value, min, max, fallback) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

  // rangeStart/rangeEnd 参与可见区间的下标换算，sampleRate 会下发到后端命令。
  merged.rangeStart = clamp(merged.rangeStart, 0, 1000, defaultSettings.rangeStart);
  merged.rangeEnd = clamp(merged.rangeEnd, 0, 1000, defaultSettings.rangeEnd);
  if (merged.rangeStart > merged.rangeEnd) {
    const swap = merged.rangeStart;
    merged.rangeStart = merged.rangeEnd;
    merged.rangeEnd = swap;
  }
  merged.sampleRate = Math.round(clamp(merged.sampleRate, 10, 60_000, defaultSettings.sampleRate));
  // 纵向余量参与 Y 轴量程计算，坏值会直接污染 scale
  if (merged.chartHeadroomMode !== 'auto' && merged.chartHeadroomMode !== 'custom') {
    merged.chartHeadroomMode = defaultSettings.chartHeadroomMode;
  }
  merged.chartHeadroomPercent = Math.round(
    clamp(merged.chartHeadroomPercent, 0, 100, defaultSettings.chartHeadroomPercent),
  );
  // 缩放比例直接改布局视口；越界或非数会让界面缩到不可用 / 撑出窗口
  merged.uiScalePercent = clampUiScalePercent(merged.uiScalePercent);
  // activeView 会被 shell 用来切换视图，白名单校验防止坏值卡死在不存在的视图
  // （'device' 视图已并入 settings，旧存值一并回落到 monitor）
  if (!['monitor', 'pd', 'settings'].includes(merged.activeView)) {
    merged.activeView = defaultSettings.activeView;
  }
  if (merged.tempSource !== 'device' && merged.tempSource !== 'external') {
    merged.tempSource = defaultSettings.tempSource;
  }
  if (merged.theme !== 'dark' && merged.theme !== 'light' && merged.theme !== 'system') {
    merged.theme = defaultSettings.theme;
  }
  merged.windowMaterial = merged.windowMaterial !== false;
  merged.realtimePanelWidth = Math.round(
    clamp(merged.realtimePanelWidth, 200, 360, defaultSettings.realtimePanelWidth),
  );
  merged.pdSplitSide = merged.pdSplitSide === true;
  return merged;
}

/**
 * 把采样率写入状态、下拉框，已连接时下发后端。
 * @param {number} rate
 */
export async function applySampleRate(rate) {
  const clamped = Math.round(Math.min(60_000, Math.max(10, Number(rate) || defaultSettings.sampleRate)));
  state.settings.sampleRate = clamped;
  const rateSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
  if (rateSelect) setSampleRateOption(rateSelect, clamped);
  if (state.isConnected) {
    try {
      await window.__TAURI__.core.invoke('set_sample_rate', { rate: clamped });
    } catch (err) {
      console.error('Failed to set sample rate:', err);
    }
  }
  updateSampleRateStatus();
}

function echoRangeUI() {
  const start = /** @type {HTMLInputElement|null} */ (document.getElementById('range-start'));
  const end = /** @type {HTMLInputElement|null} */ (document.getElementById('range-end'));
  if (start) start.value = String(state.settings.rangeStart);
  if (end) end.value = String(state.settings.rangeEnd);
  updateSliderFill();
}

/** 回显自动暂停阈值单位（loadSettings / resetSettings / 控件变更共用）。 */
export function echoApUnit() {
  const basis = /** @type {HTMLSelectElement|null} */ (document.getElementById('ap-basis'));
  const apUnit = document.getElementById('ap-unit');
  if (!apUnit) return;
  const value = basis?.value ?? state.autoPauseSettings.basis;
  if (value === 'voltage') apUnit.textContent = 'V';
  else if (value === 'current') apUnit.textContent = 'A';
  else if (value === 'power') apUnit.textContent = 'W';
  else apUnit.textContent = '';
}

/** 把当前 settings / autoPause 写回控件（loadSettings / resetSettings 共用）。 */
function echoSettingsUI() {
  const rateSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
  if (rateSelect) setSampleRateOption(rateSelect, state.settings.sampleRate);

  /** @param {string} id @param {boolean} val */
  const setChecked = (id, val) => {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.checked = val;
  };
  setChecked('show-voltage', state.settings.showVoltage);
  setChecked('show-current', state.settings.showCurrent);
  setChecked('show-power', state.settings.showPower);
  setChecked('show-temp', state.settings.showTemp);
  setChecked('show-dpdn', state.settings.showDpDn);
  setChecked('show-cc', state.settings.showCc);
  setChecked('signed-current', state.settings.signedCurrent);
  setChecked('pd-follow-recording', state.settings.pdFollowRecording);
  echoHeadroomUI();

  const tempIp = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
  if (tempIp) tempIp.value = state.settings.tempIp || '127.0.0.1';
  const tempPort = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
  if (tempPort) tempPort.value = String(state.settings.tempPort || 1573);
  syncTempSourceUI();
  echoRangeUI();

  /** @param {string} id @param {number} val */
  const setOp = (id, val) => {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.value = String(val);
  };
  setOp('opacity-voltage', state.settings.opacityVoltage);
  setOp('opacity-current', state.settings.opacityCurrent);
  setOp('opacity-power', state.settings.opacityPower);
  setOp('opacity-temp', state.settings.opacityTemp);

  const statsRangeToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('stats-range-toggle'));
  if (statsRangeToggle) statsRangeToggle.checked = state.settings.statsRange;

  syncAutoPauseUI(state.autoPauseSettings.enabled);
  const apBasis = /** @type {HTMLSelectElement|null} */ (document.getElementById('ap-basis'));
  if (apBasis) apBasis.value = state.autoPauseSettings.basis;
  const apCondition = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-condition'));
  if (apCondition) apCondition.value = String(state.autoPauseSettings.condition);
  const apDuration = /** @type {HTMLInputElement|null} */ (document.getElementById('ap-duration'));
  if (apDuration) apDuration.value = String(state.autoPauseSettings.duration);
  echoApUnit();

  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
}

/** 回显图表纵向余量控件（loadSettings / resetSettings 共用）。 */
function echoHeadroomUI() {
  const isCustom = state.settings.chartHeadroomMode === 'custom';
  const auto = /** @type {HTMLInputElement|null} */ (document.getElementById('headroom-mode-auto'));
  const custom = /** @type {HTMLInputElement|null} */ (document.getElementById('headroom-mode-custom'));
  const percent = /** @type {HTMLInputElement|null} */ (document.getElementById('headroom-percent'));
  if (auto) auto.checked = !isCustom;
  if (custom) custom.checked = isCustom;
  if (percent) {
    percent.value = String(state.settings.chartHeadroomPercent);
    percent.disabled = !isCustom;
  }
}

/**
 * 监控页读数栏宽度。inline style 是用户偏好；窄窗用 CSS max-width 裁可视宽度，不改偏好。
 * @param {number} [px]
 * @param {{ persistAria?: boolean, commit?: boolean }} [opts]
 *   persistAria / commit 默认 true。拖动预览传 false，松手再按是否真的改了可视宽度写入。
 * @returns {number}
 */
export function applyRealtimePanelWidth(px = state.settings.realtimePanelWidth, opts = {}) {
  const persistAria = opts.persistAria !== false;
  const commit = opts.commit !== false;
  const width = Math.round(Math.min(360, Math.max(200, Number(px) || defaultSettings.realtimePanelWidth)));
  if (commit) state.settings.realtimePanelWidth = width;
  const panel = document.querySelector('.realtime-panel');
  if (panel instanceof HTMLElement) panel.style.width = `${width}px`;
  if (persistAria && commit) {
    document.getElementById('monitor-splitter')?.setAttribute('aria-valuenow', String(width));
  }
  return width;
}

function echoRealtimePanelWidth() {
  applyRealtimePanelWidth(state.settings.realtimePanelWidth);
}
function echoUiScaleUI() {
  const slider = /** @type {HTMLInputElement|null} */ (document.getElementById('ui-scale'));
  if (slider) slider.value = String(state.settings.uiScalePercent);
  const label = document.getElementById('ui-scale-value');
  if (label) label.textContent = `${state.settings.uiScalePercent}%`;
}

/** @param {unknown} saved @returns {import('./state.js').AutoPauseSettings} */
function normalizeAutoPause(saved) {
  const source = /** @type {Partial<import('./state.js').AutoPauseSettings>} */ (
    saved && typeof saved === 'object' ? saved : {}
  );
  const merged = { ...defaultAutoPauseSettings, ...source, triggerStartTime: null };

  // 这两个值参与自动停止的数值比较，非数值会让比较结果不可预期。
  if (!Number.isFinite(merged.condition)) merged.condition = defaultAutoPauseSettings.condition;
  if (!Number.isFinite(merged.duration)) merged.duration = defaultAutoPauseSettings.duration;
  return merged;
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
      if (savedSettings.autoPause) {
        state.autoPauseSettings = normalizeAutoPause(savedSettings.autoPause);
      }
    }
    echoSettingsUI();
  } catch (e) {
    console.error('Failed to load settings:', e);
  } finally {
    echoUiScaleUI();
    echoThemeUI();
    echoWindowMaterialUI();
    echoRealtimePanelWidth();
    fillUiScaleHint();
    try {
      applyThemePreference(state.settings.theme);
      await applyUiScale(state.settings.uiScalePercent);
    } catch {
      /* apply 内部已有 CSS 回退；这里只保证 isLoadingSettings 一定复位 */
    }
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

    echoSettingsUI();
    echoUiScaleUI();
    echoThemeUI();
    echoWindowMaterialUI();
    echoRealtimePanelWidth();
    applyThemePreference(state.settings.theme);
    void setWindowMaterialEnabled(state.settings.windowMaterial);
    await applyUiScale(state.settings.uiScalePercent);

    // 方向设置回落到默认（关闭）后，侧栏方向箭头一并复位
    const dirEl = document.getElementById('rt-current-dir');
    if (dirEl) dirEl.hidden = true;

    await applySampleRate(state.settings.sampleRate);

    // Update chart visibility & fill (temp is handled by updateTempUIVisibility below)
    setSeriesVisible(0, state.settings.showVoltage);
    setSeriesVisible(1, state.settings.showCurrent);
    setSeriesVisible(2, state.settings.showPower);
    setSeriesVisible(4, state.settings.showDpDn);
    setSeriesVisible(5, state.settings.showDpDn);
    setSeriesVisible(6, state.settings.showCc);
    setSeriesVisible(7, state.settings.showCc);
    setSeriesFill(0, state.settings.opacityVoltage);
    setSeriesFill(1, state.settings.opacityCurrent);
    setSeriesFill(2, state.settings.opacityPower);
    setSeriesFill(3, state.settings.opacityTemp);
    refreshChartScales();

    updateStatsDisplay();
    updateEnergyDisplay();
    updateTempUIVisibility();

    // Clear saved settings from store
    const store = await getStore();
    await store.delete('appSettings');
    await store.save();
  } catch (e) {
    console.error('Failed to reset settings:', e);
  }
}
