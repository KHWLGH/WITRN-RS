// @ts-check
/**
 * @file 应用入口 — Tauri API 导入、窗口关闭、UI 事件绑定、DOMContentLoaded 初始化。
 */

import { state } from './state.js';
import { hexToRgba } from './utils.js';
import { loadSettings, saveSettings, debouncedSaveSettings, resetSettings } from './settings.js';
import { initChart, rebuildRenderSeries, rebuildNavigatorSeries } from './chart.js';
import {
  addDataPoint,
  updateSliderFill,
  updateChartRange,
  updateStatsDisplay,
  startRecording,
  stopRecording,
  clearAndResetStats,
} from './data.js';
import { refreshDeviceList, onDeviceSelect, connectDevice, disconnectDevice } from './device.js';
import { exportCSV, importCSV } from './csv.js';
import { connectTempService, disconnectTempService, setTempConnected, updateTempUIVisibility } from './temperature.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { ask, message } = window.__TAURI__.dialog;

// ─── Close confirmation ──────────────────────────────────────────────────────

let __isClosingWindow = false;
/** @type {(() => void)|null} */
let __unlistenCloseRequested = null;

/**
 * 带超时的 Promise 包装器。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function __withTimeout(promise, ms, fallback) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }));
}

async function setupCloseConfirm() {
  try {
    const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
    if (typeof getCurrentWindow !== 'function') return;

    const appWindow = getCurrentWindow();
    if (!appWindow || typeof appWindow.onCloseRequested !== 'function') return;

    __unlistenCloseRequested = await appWindow.onCloseRequested(async (/** @type {any} */ event) => {
      try { event.preventDefault(); } catch { /* noop */ }

      if (__isClosingWindow) {
        // exit_app calls process::exit — if it somehow times out, fall through to JS-level close
        try { await __withTimeout(invoke('exit_app'), 800, null); } catch { /* noop */ }
        try { if (typeof appWindow.destroy === 'function') await __withTimeout(appWindow.destroy(), 300, null); } catch { /* noop */ }
        try { appWindow.close(); } catch { /* noop */ }
        return;
      }

      let confirmed = true;
      try {
        confirmed = /** @type {boolean} */ (await __withTimeout(
          ask('确定要退出吗？', { title: '确认退出', type: 'warning' }),
          5_000,
          true,
        ));
      } catch {
        confirmed = true;
      }

      if (!confirmed) return;

      __isClosingWindow = true;

      try {
        if (typeof __unlistenCloseRequested === 'function') __unlistenCloseRequested();
      } catch { /* noop */ }
      __unlistenCloseRequested = null;

      try { await __withTimeout(invoke('disconnect_device'), 500, null); } catch (e) { console.warn('disconnect_device failed during close:', e); }
      try { await __withTimeout(invoke('disconnect_temp_service'), 500, null); } catch (e) { console.warn('disconnect_temp_service failed during close:', e); }
      try { await __withTimeout(saveSettings(), 2000, null); } catch (e) { console.warn('saveSettings failed during close:', e); }

      try { await __withTimeout(invoke('close_main_window'), 300, null); return; } catch (e) { console.warn('close_main_window failed:', e); }
      try { await __withTimeout(invoke('exit_app'), 1000, null); return; } catch (e) { console.warn('exit_app failed:', e); }
      try { if (typeof appWindow.destroy === 'function') await __withTimeout(appWindow.destroy(), 500, null); } catch (e) { console.warn('appWindow.destroy failed:', e); }
      try { appWindow.close(); } catch (e) { console.warn('appWindow.close failed:', e); }
    });
  } catch (e) {
    console.error('Failed to setup close confirm:', e);
  }
}

// ─── Chart toggles ───────────────────────────────────────────────────────────

function setupChartToggles() {
  const fields = ['voltage', 'current', 'power', 'temp'];
  fields.forEach((field, index) => {
    const checkbox = /** @type {HTMLInputElement|null} */ (document.getElementById(`show-${field}`));
    if (!checkbox) return;
    const key = `show${field.charAt(0).toUpperCase() + field.slice(1)}`;

    // @ts-ignore — dynamic key
    state.settings[key] = checkbox.checked;

    if (state.mainChart && typeof state.mainChart.setDatasetVisibility === 'function') {
      const shouldShow = field === 'temp' ? (checkbox.checked && (state.isTempConnected || state.hasTempData)) : checkbox.checked;
      state.mainChart.setDatasetVisibility(index, shouldShow);
    } else if (state.mainChart?.data?.datasets[index]) {
      state.mainChart.data.datasets[index].hidden = !checkbox.checked;
    }
    if (state.mainChart?.options?.scales) {
      const shouldShow = field === 'temp' ? (checkbox.checked && (state.isTempConnected || state.hasTempData)) : checkbox.checked;
      state.mainChart.options.scales[`y-${field}`].display = shouldShow;
    }

    checkbox.addEventListener('change', () => {
      // @ts-ignore — dynamic key
      state.settings[key] = checkbox.checked;

      if (field === 'temp') {
        updateTempUIVisibility();
        debouncedSaveSettings();
        return;
      }

      if (state.mainChart && typeof state.mainChart.setDatasetVisibility === 'function') {
        state.mainChart.setDatasetVisibility(index, checkbox.checked);
      } else if (state.mainChart?.data?.datasets[index]) {
        state.mainChart.data.datasets[index].hidden = !checkbox.checked;
      }
      if (state.mainChart?.options?.scales) {
        state.mainChart.options.scales[`y-${field}`].display = checkbox.checked;
      }
      state.mainChart.update();
      debouncedSaveSettings();
    });
  });

  // Fill controls — opacity input drives both opacity and fill (0 = fill off)
  /** @type {{ opId: string, key: string }[]} */
  const fillControls = [
    { opId: 'opacity-voltage', key: 'Voltage' },
    { opId: 'opacity-current', key: 'Current' },
    { opId: 'opacity-power', key: 'Power' },
    { opId: 'opacity-temp', key: 'Temp' },
  ];

  fillControls.forEach((ctrl, index) => {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(ctrl.opId));

    if (input) {
      input.addEventListener('input', (e) => {
        let val = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
        if (isNaN(val)) val = 15;
        if (val < 0) val = 0;
        if (val > 100) val = 100;

        const fill = val > 0;
        // @ts-ignore — dynamic key
        state.settings[`opacity${ctrl.key}`] = val;
        // @ts-ignore — dynamic key
        state.settings[`fill${ctrl.key}`] = fill;

        if (state.mainChart?.data?.datasets[index]) {
          state.mainChart.data.datasets[index].fill = fill;
          const hex = state.mainChart.data.datasets[index].borderColor;
          state.mainChart.data.datasets[index].backgroundColor = hexToRgba(hex, val);
          state.mainChart.update('none');
        }
        debouncedSaveSettings();
      });
    }
  });

  if (state.mainChart) state.mainChart.update();
}

// ─── Controls ────────────────────────────────────────────────────────────────

function setupControls() {
  const rangeStart = /** @type {HTMLInputElement} */ (document.getElementById('range-start'));
  const rangeEnd = /** @type {HTMLInputElement} */ (document.getElementById('range-end'));
  const handleStart = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-start'));
  const handleEnd = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-end'));
  const sliderContainer = /** @type {HTMLElement|null} */ (document.querySelector('.dual-slider-container'));

  state.__setRangeControlsEnabled = (enabled) => {
    if (rangeStart) rangeStart.disabled = !enabled;
    if (rangeEnd) rangeEnd.disabled = !enabled;

    if (handleStart) {
      handleStart.tabIndex = enabled ? 0 : -1;
      if (!enabled) handleStart.blur();
    }
    if (handleEnd) {
      handleEnd.tabIndex = enabled ? 0 : -1;
      if (!enabled) handleEnd.blur();
    }

    if (sliderContainer) sliderContainer.classList.toggle('disabled', !enabled);
  };

  /** @param {number} value @param {number} min @param {number} max @returns {number} */
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /**
   * @param {number|string} nextStart
   * @param {number|string} nextEnd
   * @param {'start'|'end'} leader
   */
  function applyRangeValues(nextStart, nextEnd, leader) {
    if (state.isRecording) return;
    let start = clamp(parseInt(String(nextStart)), 0, 1000);
    let end = clamp(parseInt(String(nextEnd)), 0, 1000);

    if (start > end) {
      if (leader === 'start') start = end;
      else end = start;
    }

    rangeStart.value = String(start);
    rangeEnd.value = String(end);
    state.settings.rangeStart = start;
    state.settings.rangeEnd = end;

    updateSliderFill();
    updateChartRange();
    if (state.settings.statsRange) updateStatsDisplay();
    state.mainChart.update();
  }

  /** @param {'start'|'end'} leader */
  function onSliderChange(leader) {
    applyRangeValues(rangeStart.value, rangeEnd.value, leader);
  }

  rangeStart.addEventListener('input', () => onSliderChange('start'));
  rangeEnd.addEventListener('input', () => onSliderChange('end'));

  /** @param {PointerEvent|MouseEvent} event @returns {number} */
  function valueFromPointerEvent(event) {
    if (!sliderContainer) return 0;
    const rect = sliderContainer.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return clamp(Math.round(ratio * 1000), 0, 1000);
  }

  /**
   * @param {HTMLElement|null} handle
   * @param {'start'|'end'} which
   */
  function setupHandleInteractions(handle, which) {
    if (!handle) return;

    handle.addEventListener('pointerdown', (event) => {
      if (state.isRecording) return;
      event.preventDefault();
      handle.focus();
      handle.setPointerCapture(event.pointerId);

      const newValue = valueFromPointerEvent(event);
      if (which === 'start') applyRangeValues(newValue, rangeEnd.value, 'start');
      else applyRangeValues(rangeStart.value, newValue, 'end');
    });

    handle.addEventListener('pointermove', (event) => {
      if (state.isRecording) return;
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const newValue = valueFromPointerEvent(event);
      if (which === 'start') applyRangeValues(newValue, rangeEnd.value, 'start');
      else applyRangeValues(rangeStart.value, newValue, 'end');
    });

    handle.addEventListener('keydown', (event) => {
      if (state.isRecording) return;
      const key = event.key;
      const isLeft = key === 'ArrowLeft';
      const isRight = key === 'ArrowRight';
      const isHome = key === 'Home';
      const isEnd = key === 'End';
      if (!isLeft && !isRight && !isHome && !isEnd) return;

      event.preventDefault();

      const baseStep = event.shiftKey ? 10 : (event.ctrlKey ? 50 : 1);
      const current = which === 'start' ? parseInt(rangeStart.value) : parseInt(rangeEnd.value);
      let next = current;

      if (isHome) next = 0;
      else if (isEnd) next = 1000;
      else if (isLeft) next = current - baseStep;
      else if (isRight) next = current + baseStep;

      next = clamp(next, 0, 1000);
      if (which === 'start') applyRangeValues(next, rangeEnd.value, 'start');
      else applyRangeValues(rangeStart.value, next, 'end');
    });
  }

  setupHandleInteractions(handleStart, 'start');
  setupHandleInteractions(handleEnd, 'end');

  updateSliderFill();

  if (typeof state.__setRangeControlsEnabled === 'function') {
    state.__setRangeControlsEnabled(!state.isRecording);
  }

  // Sample rate
  const sampleRateEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
  if (sampleRateEl) {
    sampleRateEl.addEventListener('change', async (e) => {
      state.settings.sampleRate = parseInt(/** @type {HTMLSelectElement} */ (e.target).value);
      updateChartRange();
      state.mainChart.update();
      if (state.isConnected) {
        try { await invoke('set_sample_rate', { rate: state.settings.sampleRate }); } catch (err) { console.error('Failed to set sample rate:', err); }
      }
      debouncedSaveSettings();
    });
  }

  // Buttons
  /** @param {string} id @param {(e: Event) => void} handler */
  const btn = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handler(e); });
  };

  btn('btn-connect', () => connectDevice());
  btn('btn-disconnect', () => disconnectDevice());
  btn('btn-refresh-devices', () => refreshDeviceList());

  const deviceSelect = document.getElementById('device-select');
  if (deviceSelect) deviceSelect.addEventListener('change', onDeviceSelect);

  btn('btn-start-record', () => startRecording());
  btn('btn-stop-record', () => stopRecording());

  // Stats range toggle
  const statsRangeToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('stats-range-toggle'));
  if (statsRangeToggle) {
    statsRangeToggle.addEventListener('change', (e) => {
      state.settings.statsRange = /** @type {HTMLInputElement} */ (e.target).checked;
      updateStatsDisplay();
      debouncedSaveSettings();
    });
  }

  // Downsample controls
  const downsampleToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('downsample-toggle'));
  const downsampleLevel = /** @type {HTMLSelectElement|null} */ (document.getElementById('downsample-level'));
  if (downsampleToggle) {
    downsampleToggle.addEventListener('change', (e) => {
      state.settings.downsampleEnabled = /** @type {HTMLInputElement} */ (e.target).checked;
      if (downsampleLevel) downsampleLevel.disabled = !state.settings.downsampleEnabled;
      rebuildRenderSeries();
      rebuildNavigatorSeries();
      if (state.mainChart) state.mainChart.update('none');
      if (state.navigatorChart) state.navigatorChart.update('none');
      debouncedSaveSettings();
    });
  }
  if (downsampleLevel) {
    downsampleLevel.addEventListener('change', (e) => {
      state.settings.downsampleLevel = /** @type {'low'|'medium'|'high'} */ (/** @type {HTMLSelectElement} */ (e.target).value);
      rebuildRenderSeries();
      rebuildNavigatorSeries();
      if (state.mainChart) state.mainChart.update('none');
      if (state.navigatorChart) state.navigatorChart.update('none');
      debouncedSaveSettings();
    });
  }

  // Export dropdown menu
  const exportBtn = document.getElementById('btn-export');
  const exportDropdown = document.getElementById('export-dropdown');
  const exportNoTemp = document.getElementById('export-no-temp');
  const exportWithTemp = document.getElementById('export-with-temp');

  if (exportBtn && exportDropdown) {
    const updatePosition = () => {
      if (exportDropdown.classList.contains('show')) {
        const rect = exportBtn.getBoundingClientRect();
        exportDropdown.style.top = `${rect.bottom + 2}px`;
        exportDropdown.style.left = `${rect.left}px`;
      }
    };

    /** @param {boolean} show */
    const toggleDropdown = (show) => {
      if (show) {
        exportDropdown.style.position = 'fixed';
        exportDropdown.style.width = 'auto';
        exportDropdown.style.minWidth = '120px';
        exportDropdown.classList.add('show');
        updatePosition();
      } else {
        exportDropdown.classList.remove('show');
      }
    };

    exportBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isShown = exportDropdown.classList.contains('show');
      toggleDropdown(!isShown);
    });

    document.addEventListener('click', (e) => {
      if (!exportBtn.contains(/** @type {Node} */ (e.target)) && !exportDropdown.contains(/** @type {Node} */ (e.target))) {
        toggleDropdown(false);
      }
    });

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    if (exportNoTemp) exportNoTemp.addEventListener('click', () => { toggleDropdown(false); exportCSV(false); });
    if (exportWithTemp) exportWithTemp.addEventListener('click', () => { toggleDropdown(false); exportCSV(true); });
  }

  const importBtn = document.getElementById('btn-import');
  if (importBtn) importBtn.addEventListener('click', importCSV);

  btn('btn-reset-settings', async () => {
    const yes = await ask('确定要重置所有配置为默认值吗？', { title: '确认重置配置', type: 'warning' });
    if (yes) await resetSettings();
  });

  btn('btn-clear-chart', async () => {
    const yes = await ask('确定要清空图表并重置所有统计数据吗？', { title: '确认重置', type: 'warning' });
    if (yes) clearAndResetStats();
  });

  // Temperature service controls
  btn('btn-temp-connect', () => connectTempService());
  btn('btn-temp-disconnect', () => disconnectTempService());

  const tempIpEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
  if (tempIpEl) {
    tempIpEl.addEventListener('change', (e) => {
      state.settings.tempIp = /** @type {HTMLInputElement} */ (e.target).value;
      debouncedSaveSettings();
    });
  }

  const tempPortEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
  if (tempPortEl) {
    tempPortEl.addEventListener('change', (e) => {
      state.settings.tempPort = parseInt(/** @type {HTMLInputElement} */ (e.target).value) || 1573;
      debouncedSaveSettings();
    });
  }

  // Auto Pause Controls
  const apToggle = /** @type {HTMLInputElement} */ (document.getElementById('btn-auto-pause-toggle'));
  const apBasis = /** @type {HTMLSelectElement} */ (document.getElementById('ap-basis'));
  const apCondition = /** @type {HTMLInputElement} */ (document.getElementById('ap-condition'));
  const apDuration = /** @type {HTMLInputElement} */ (document.getElementById('ap-duration'));
  const apUnit = document.getElementById('ap-unit');

  function updateApUnit() {
    const basis = apBasis.value;
    if (apUnit) {
      if (basis === 'voltage') apUnit.textContent = 'V';
      else if (basis === 'current') apUnit.textContent = 'A';
      else if (basis === 'power') apUnit.textContent = 'W';
      else apUnit.textContent = '';
    }
  }

  if (apToggle) {
    apToggle.addEventListener('change', () => {
      state.autoPauseSettings.enabled = apToggle.checked;
      state.autoPauseSettings.triggerStartTime = null;
      debouncedSaveSettings();
    });
  }

  if (apBasis) {
    apBasis.addEventListener('change', (e) => {
      state.autoPauseSettings.basis = /** @type {'none'|'voltage'|'current'|'power'} */ (/** @type {HTMLSelectElement} */ (e.target).value);
      state.autoPauseSettings.triggerStartTime = null;
      updateApUnit();
      debouncedSaveSettings();
    });

    updateApUnit();
  }

  if (apCondition) {
    apCondition.addEventListener('change', (e) => {
      state.autoPauseSettings.condition = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      state.autoPauseSettings.triggerStartTime = null;
      debouncedSaveSettings();
    });
  }

  if (apDuration) {
    apDuration.addEventListener('change', (e) => {
      state.autoPauseSettings.duration = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      state.autoPauseSettings.triggerStartTime = null;
      debouncedSaveSettings();
    });
  }

  // Initialize from DOM
  if (apBasis) state.autoPauseSettings.basis = /** @type {'none'|'voltage'|'current'|'power'} */ (apBasis.value);
  if (apCondition) state.autoPauseSettings.condition = parseFloat(apCondition.value) || 0;
  if (apDuration) state.autoPauseSettings.duration = parseFloat(apDuration.value) || 0;
}

// ─── Event listeners ─────────────────────────────────────────────────────────

async function setupEventListener() {
  await listen('device-data', (/** @type {{ payload: import('./state.js').DeviceData }} */ event) => {
    addDataPoint(event.payload);
  });

  await listen('device-disconnected', async () => {
    if (state.isConnected) {
      await disconnectDevice();
      await message('设备连接已断开', { title: '连接断开', type: 'warning' });
    }
  });

  await listen('temp-data', (/** @type {{ payload: number }} */ event) => {
    state.currentTemp = event.payload;
    if (state.isTempConnected) {
      const el = document.getElementById('rt-temp');
      if (el) el.textContent = state.currentTemp.toFixed(1);
    }
  });

  await listen('temp-disconnected', () => {
    setTempConnected(false);
    console.info('Temperature service disconnected');
  });
}

// ─── Initialize ──────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  // 禁用右键菜单
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  console.log('=== DOMContentLoaded START ===');

  // Direct store test
  try {
    console.log('Testing store with raw invoke...');
    const rid = await invoke('plugin:store|load', { path: 'settings.json', options: {} });
    console.log('Store loaded, rid:', rid);
    const result = await invoke('plugin:store|get', { rid, key: 'appSettings' });
    console.log('Raw store get result:', result);
  } catch (e) {
    console.error('Raw store test failed:', e);
  }

  await setupCloseConfirm();
  await loadSettings();
  initChart();
  setupChartToggles();
  setupControls();

  // Clean recording state on load
  state.isRecording = false;
  state.recordedData = [];

  await setupEventListener();
  await refreshDeviceList();

  updateTempUIVisibility();

  console.log('=== DOMContentLoaded END ===');
});
