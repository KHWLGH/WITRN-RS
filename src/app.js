// @ts-check
/**
 * @file 应用入口 — Tauri API 导入、窗口关闭、UI 事件绑定、DOMContentLoaded 初始化。
 */

import { initChart, scheduleChartUpdate, setSeriesFill, setSeriesVisible, updateCharts } from './chart.js';
import { exportCSV, importCSV } from './csv.js';
import {
  addDataPoint,
  clearAndResetStats,
  scheduleStatsUpdate,
  startRecording,
  stopRecording,
  updateChartRange,
  updateEnergyDisplay,
  updateSliderFill,
  updateStatsDisplay,
} from './data.js';
import { connectDevice, disconnectDevice, onDeviceSelect, refreshDeviceList } from './device.js';
import { enhanceSelects } from './dropdown.js';
import { debouncedSaveSettings, loadSettings, resetSettings, saveSettings } from './settings.js';
import { state } from './state.js';
import { connectTempService, disconnectTempService, setTempConnected, updateTempUIVisibility } from './temperature.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { ask, message } = window.__TAURI__.dialog;

// ─── Close confirmation ──────────────────────────────────────────────────────

let __isClosingWindow = false;

/**
 * 退出确认。确认后由后端 `shutdown` 停止后台任务并 destroy 主窗口。
 *
 * destroy 不会重新派发 close-requested，因此这里既不需要注销监听器，也不需要备用关闭路径。
 * 关闭动作必须走后端：前端的 `close()` / `destroy()` 属于 `core:window:allow-*` 权限，
 * 本应用的 capability 只声明了 `core:default`（窗口部分是只读的），调用会被 ACL 拒绝。
 */
async function setupCloseConfirm() {
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  await appWindow.onCloseRequested(async (/** @type {any} */ event) => {
    event.preventDefault();
    if (__isClosingWindow) return;

    const confirmed = await ask('确定要退出吗？', { title: '确认退出', kind: 'warning' });
    if (!confirmed) return;
    __isClosingWindow = true;

    // 设置里可能还压着一次未触发的防抖保存；saveSettings 自身已吞掉写盘异常。
    await saveSettings();

    try {
      await invoke('shutdown');
    } catch (e) {
      // 退出失败必须复位，否则窗口再也关不掉。
      console.error('退出失败:', e);
      __isClosingWindow = false;
    }
  });
}

// ─── Chart toggles ───────────────────────────────────────────────────────────

function setupChartToggles() {
  const fields = ['voltage', 'current', 'power', 'temp'];
  fields.forEach((field, index) => {
    const checkbox = /** @type {HTMLInputElement|null} */ (document.getElementById(`show-${field}`));
    if (!checkbox) return;
    const key = `show${field.charAt(0).toUpperCase() + field.slice(1)}`;

    state.settings[key] = checkbox.checked;

    const effectiveShow =
      field === 'temp' ? checkbox.checked && (state.isTempConnected || state.hasTempData) : checkbox.checked;
    setSeriesVisible(index, effectiveShow);

    checkbox.addEventListener('change', () => {
      state.settings[key] = checkbox.checked;

      if (field === 'temp') {
        updateTempUIVisibility();
        debouncedSaveSettings();
        return;
      }

      setSeriesVisible(index, checkbox.checked);
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
        let val = Number.parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10);
        if (Number.isNaN(val)) val = 15;
        if (val < 0) val = 0;
        if (val > 100) val = 100;

        state.settings[`opacity${ctrl.key}`] = val;
        setSeriesFill(index, val);
        debouncedSaveSettings();
      });
    }
  });
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
    let start = clamp(Number.parseInt(String(nextStart), 10), 0, 1000);
    let end = clamp(Number.parseInt(String(nextEnd), 10), 0, 1000);

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
    // 拖动期间逐事件同步重建大数据量图表会卡顿，统一用 rAF 合并到每帧一次
    if (state.settings.statsRange) scheduleStatsUpdate();
    scheduleChartUpdate();
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

      const baseStep = event.shiftKey ? 10 : event.ctrlKey ? 50 : 1;
      const current = which === 'start' ? Number.parseInt(rangeStart.value, 10) : Number.parseInt(rangeEnd.value, 10);
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

  state.__setRangeControlsEnabled?.(!state.isRecording);

  // Sample rate
  const sampleRateEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
  if (sampleRateEl) {
    sampleRateEl.addEventListener('change', async (e) => {
      state.settings.sampleRate = Number.parseInt(/** @type {HTMLSelectElement} */ (e.target).value, 10);
      updateChartRange();
      updateCharts();
      if (state.isConnected) {
        try {
          await invoke('set_sample_rate', { rate: state.settings.sampleRate });
        } catch (err) {
          console.error('Failed to set sample rate:', err);
        }
      }
      debouncedSaveSettings();
    });
  }

  // Buttons
  /** @param {string} id @param {(e: Event) => void} handler */
  const btn = (id, handler) => {
    const el = document.getElementById(id);
    if (el)
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler(e);
      });
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
      updateEnergyDisplay();
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
      exportBtn.setAttribute('aria-expanded', String(show));
      if (show) {
        exportDropdown.style.position = 'fixed';
        exportDropdown.style.width = 'auto';
        exportDropdown.style.minWidth = '120px';
        exportDropdown.classList.add('show');
        updatePosition();
        const firstItem = /** @type {HTMLElement|null} */ (exportDropdown.querySelector('[role="menuitem"]'));
        if (firstItem) firstItem.focus();
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
      if (
        !exportBtn.contains(/** @type {Node} */ (e.target)) &&
        !exportDropdown.contains(/** @type {Node} */ (e.target))
      ) {
        toggleDropdown(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && exportDropdown.classList.contains('show')) {
        toggleDropdown(false);
        exportBtn.focus();
      }
    });

    exportDropdown.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const candidates = /** @type {NodeListOf<HTMLButtonElement>} */ (
        exportDropdown.querySelectorAll('[role="menuitem"]')
      );
      const items = Array.from(candidates).filter((item) => !item.disabled && !item.classList.contains('hidden'));
      if (items.length === 0) return;

      e.preventDefault();
      const activeElement = document.activeElement;
      const current = activeElement instanceof HTMLButtonElement ? items.indexOf(activeElement) : -1;
      let next = current;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
      else next = (current - 1 + items.length) % items.length;
      items[next].focus();
    });

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    if (exportNoTemp)
      exportNoTemp.addEventListener('click', () => {
        toggleDropdown(false);
        exportCSV(false);
      });
    if (exportWithTemp)
      exportWithTemp.addEventListener('click', () => {
        toggleDropdown(false);
        exportCSV(true);
      });
  }

  const importBtn = document.getElementById('btn-import');
  if (importBtn) importBtn.addEventListener('click', importCSV);

  btn('btn-reset-settings', async () => {
    const yes = await ask('确定要重置所有配置为默认值吗？', { title: '确认重置配置', kind: 'warning' });
    if (yes) await resetSettings();
  });

  btn('btn-clear-chart', async () => {
    const yes = await ask('确定要清空图表并重置所有统计数据吗？', { title: '确认重置', kind: 'warning' });
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
      const input = /** @type {HTMLInputElement} */ (e.target);
      const port = Number.parseInt(input.value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        input.value = String(state.settings.tempPort);
        alert('请输入 1 到 65535 之间的有效端口');
        return;
      }
      state.settings.tempPort = port;
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
      state.autoPauseSettings.basis = /** @type {'none'|'voltage'|'current'|'power'} */ (
        /** @type {HTMLSelectElement} */ (e.target).value
      );
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
      await message('设备连接已断开', { title: '连接断开', kind: 'warning' });
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

  // 必须早于 loadSettings()，否则它对 select.value 的赋值发生在拦截器安装之前。
  enhanceSelects();

  await setupCloseConfirm();
  await loadSettings();
  initChart();
  setupChartToggles();
  setupControls();

  // Clean recording state on load
  state.isRecording = false;

  await setupEventListener();
  await refreshDeviceList();

  updateTempUIVisibility();
});
