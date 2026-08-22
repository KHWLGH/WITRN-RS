// @ts-check
/**
 * @file 应用入口 — Tauri API 导入、窗口关闭、UI 事件绑定、DOMContentLoaded 初始化。
 */

import {
  handleMonitorShown,
  initChart,
  refreshChartScales,
  scheduleChartUpdate,
  setSeriesFill,
  setSeriesVisible,
  updateCharts,
} from './chart.js';
import { exportCSV, importCSV } from './csv.js';
import {
  addDataPoint,
  clearAndResetStats,
  refreshRecordButton,
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
import { applySampleRate, debouncedSaveSettings, loadSettings, resetSettings, saveSettings } from './settings.js';
import { onSelectionChange, registerView, restoreView, showView } from './shell.js';
import { state } from './state.js';
import {
  connectTempService,
  disconnectTempService,
  setTempConnected,
  syncTempSourceUI,
  updateTempUIVisibility,
} from './temperature.js';
import { applyThemePreference } from './theme.js';
import { syncAutoPauseUI, syncFollowLinkageUI, syncTempUI } from './ui/controlbar.js';
import { ask } from './ui/dialog.js';
import { createFlyout } from './ui/flyout.js';
import { createMenu } from './ui/menu.js';
import { initTabBar } from './ui/tabbar.js';
import { toast } from './ui/toast.js';
import { initWindowControls } from './ui/windowcontrols.js';
import { applyUiScale, clampUiScalePercent, previewUiScalePercent } from './ui-scale.js';
import { initDeviceView, refreshDeviceIdentifyState } from './views/device.js';
import { clearPdEntries, ingestPdBatch, initPdView, markPdDisconnect, syncPdView } from './views/pd.js';
import { initSettingsView } from './views/settings-view.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ─── Close confirmation ──────────────────────────────────────────────────────

let __isClosingWindow = false;
let __closeConfirmOpen = false;

/**
 * 退出确认。确认后由后端 `shutdown` 停止后台任务并 destroy 主窗口。
 *
 * destroy 不会重新派发 close-requested，因此这里既不需要注销监听器，也不需要备用关闭路径。
 * 自定义标题栏的 ✕ 按钮调用 `appWindow.close()`（capability 已授予 allow-close），
 * 它只会触发本监听器；真正的销毁动作仍走后端 `shutdown`，以保证先停 HID/温度线程。
 */
async function setupCloseConfirm() {
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  await appWindow.onCloseRequested(async (/** @type {any} */ event) => {
    event.preventDefault();
    // 重复点关闭时不再叠加弹窗：确认框是模态的，焦点已在其中
    if (__isClosingWindow || __closeConfirmOpen) return;

    __closeConfirmOpen = true;
    const confirmed = await ask('确定要退出吗？', { title: '确认退出', kind: 'warning' });
    __closeConfirmOpen = false;
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

  // D+/D- 与 CC1/CC2 叠加曲线：一个复选框控制一对 series（复用电压 scale，无透明度输入）
  /** @param {string} id @param {'showDpDn'|'showCc'} key @param {number[]} datasetIndexes */
  const wirePairToggle = (id, key, datasetIndexes) => {
    const checkbox = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (!checkbox) return;
    state.settings[key] = checkbox.checked;
    for (const index of datasetIndexes) setSeriesVisible(index, checkbox.checked);
    checkbox.addEventListener('change', () => {
      state.settings[key] = checkbox.checked;
      for (const index of datasetIndexes) setSeriesVisible(index, checkbox.checked);
      debouncedSaveSettings();
    });
  };
  wirePairToggle('show-dpdn', 'showDpDn', [4, 5]);
  wirePairToggle('show-cc', 'showCc', [6, 7]);
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
      await applySampleRate(Number.parseInt(/** @type {HTMLSelectElement} */ (e.target).value, 10));
      updateChartRange();
      updateCharts();
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

  btn('btn-record-toggle', () => (state.isRecording ? stopRecording() : startRecording()));

  // PD 视图在「跟随记录」开启时需要触发这几个监控侧动作。用注入而非让 pd.js
  // 直接 import data.js：那条边会把 chart.js / temperature.js 拖进 PD 的单元测试环境。
  state.__toggleRecording = () => (state.isRecording ? stopRecording() : startRecording());
  state.__clearMonitorData = () => clearAndResetStats();

  // 记录 / 连接 / 跟随设置任一变化都要重刷记录按钮：文案与提示语都取决于它们
  // （data.js 与 csv.js 在自己的流程里也直接调，覆盖不派发事件的场景，如清空图表）
  document.addEventListener('witrn:monitor-changed', () => {
    refreshRecordButton();
    syncFollowLinkageUI(state.settings.pdFollowRecording);
  });

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

  // Export dropdown menu — 菜单项 id 保持不变：temperature.js 依赖
  // getElementById('export-with-temp') 切换其可见性
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
    createMenu(exportBtn, [
      { id: 'export-no-temp', label: '不带温度', onSelect: () => exportCSV(false) },
      { id: 'export-with-temp', label: '带温度', onSelect: () => exportCSV(true) },
    ]);
  }

  const importBtn = document.getElementById('btn-import');
  if (importBtn) importBtn.addEventListener('click', importCSV);

  btn('btn-reset-settings', async () => {
    const yes = await ask('确定要重置所有配置为默认值吗？', { title: '确认重置配置', kind: 'warning' });
    if (yes) await resetSettings();
  });

  // 主题（设置页 外观 卡）
  /** @param {'dark'|'light'|'system'} pref */
  const applyThemeChoice = (pref) => {
    state.settings.theme = pref;
    applyThemePreference(pref);
    debouncedSaveSettings();
  };
  const themeDark = /** @type {HTMLInputElement|null} */ (document.getElementById('theme-choice-dark'));
  const themeLight = /** @type {HTMLInputElement|null} */ (document.getElementById('theme-choice-light'));
  const themeSystem = /** @type {HTMLInputElement|null} */ (document.getElementById('theme-choice-system'));
  themeDark?.addEventListener('change', () => {
    if (themeDark.checked) applyThemeChoice('dark');
  });
  themeLight?.addEventListener('change', () => {
    if (themeLight.checked) applyThemeChoice('light');
  });
  themeSystem?.addEventListener('change', () => {
    if (themeSystem.checked) applyThemeChoice('system');
  });

  // 界面缩放（设置页 外观 卡）
  // 拖动只改读数：整页缩放会改滑条几何，原生 range 再跟指针就会抽搐。
  // 松手 / 键盘步进走 change，再 setZoom。
  const uiScale = /** @type {HTMLInputElement|null} */ (document.getElementById('ui-scale'));
  uiScale?.addEventListener('input', () => {
    previewUiScalePercent(Number.parseInt(uiScale.value, 10));
  });
  uiScale?.addEventListener('change', () => {
    const percent = clampUiScalePercent(Number.parseInt(uiScale.value, 10));
    uiScale.value = String(percent);
    state.settings.uiScalePercent = percent;
    void applyUiScale(percent);
    debouncedSaveSettings();
  });

  // Chart headroom（设置页 配置 卡）
  const headroomAuto = /** @type {HTMLInputElement|null} */ (document.getElementById('headroom-mode-auto'));
  const headroomCustom = /** @type {HTMLInputElement|null} */ (document.getElementById('headroom-mode-custom'));
  const headroomPercent = /** @type {HTMLInputElement|null} */ (document.getElementById('headroom-percent'));

  /** @param {'auto'|'custom'} mode */
  const applyHeadroomMode = (mode) => {
    state.settings.chartHeadroomMode = mode;
    if (headroomPercent) headroomPercent.disabled = mode !== 'custom';
    refreshChartScales();
    debouncedSaveSettings();
  };
  headroomAuto?.addEventListener('change', () => {
    if (headroomAuto.checked) applyHeadroomMode('auto');
  });
  headroomCustom?.addEventListener('change', () => {
    if (headroomCustom.checked) applyHeadroomMode('custom');
  });
  headroomPercent?.addEventListener('input', () => {
    let val = Number.parseInt(headroomPercent.value, 10);
    if (Number.isNaN(val)) val = 25;
    if (val < 0) val = 0;
    if (val > 100) val = 100;
    state.settings.chartHeadroomPercent = val;
    refreshChartScales();
    debouncedSaveSettings();
  });

  // 记录电流方向（设置页 配置 卡）
  const signedCurrentEl = /** @type {HTMLInputElement|null} */ (document.getElementById('signed-current'));
  signedCurrentEl?.addEventListener('change', () => {
    state.settings.signedCurrent = signedCurrentEl.checked;
    // 关闭后侧栏箭头立即消失，不等下一个数据点
    if (!signedCurrentEl.checked) {
      const dirEl = document.getElementById('rt-current-dir');
      if (dirEl) dirEl.hidden = true;
    }
    debouncedSaveSettings();
  });

  btn('btn-clear-chart', async () => {
    // 跟随记录开启时两侧同生共死：这里连带清掉 PD 缓冲，PD 侧的清空同样连带重置这里。
    // 两边各自只调用对方的无级联版本，不会互相递归。
    const follow = state.settings.pdFollowRecording;
    const yes = await ask(
      follow
        ? '确定要清空图表并重置所有统计数据吗？\n跟随记录已开启，PD 分析已捕获的报文也会一并清空。'
        : '确定要清空图表并重置所有统计数据吗？',
      { title: '确认重置', kind: 'error' },
    );
    if (!yes) return;
    clearAndResetStats();
    if (follow) clearPdEntries();
  });

  // Temperature service toggle (connection settings remain in the Flyout)
  btn('btn-temp-toggle', async () => {
    syncTempUI(state.isTempConnected, true);
    try {
      if (state.isTempConnected) await disconnectTempService();
      else await connectTempService();
    } finally {
      syncTempUI(state.isTempConnected);
    }
  });

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
        input.classList.add('input-invalid');
        toast.warning('请输入 1 到 65535 之间的有效端口');
        return;
      }
      input.classList.remove('input-invalid');
      state.settings.tempPort = port;
      debouncedSaveSettings();
    });
  }

  /** @param {'device'|'external'} source */
  const onTempSource = (source) => {
    if (state.isTempConnected) return;
    state.settings.tempSource = source;
    syncTempSourceUI();
    debouncedSaveSettings();
  };
  document.getElementById('temp-source-device')?.addEventListener('change', () => onTempSource('device'));
  document.getElementById('temp-source-external')?.addEventListener('change', () => onTempSource('external'));
  syncTempSourceUI();

  // Auto Pause Controls
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

  btn('btn-auto-pause-command', () => {
    state.autoPauseSettings.enabled = !state.autoPauseSettings.enabled;
    state.autoPauseSettings.triggerStartTime = null;
    syncAutoPauseUI(state.autoPauseSettings.enabled);
    debouncedSaveSettings();
  });

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
  syncAutoPauseUI(state.autoPauseSettings.enabled);
  syncTempUI(state.isTempConnected);
  refreshRecordButton();
  syncFollowLinkageUI(state.settings.pdFollowRecording);
}

// ─── Shell（多 Tab 工作区 + 标题栏） ─────────────────────────────────────────

function setupShell() {
  registerView({ id: 'monitor', icon: 'codicon-pulse', label: '监控', onShow: handleMonitorShown });
  registerView({ id: 'pd', icon: 'codicon-zap', label: 'PD 分析', init: initPdView, onShow: syncPdView });
  // 设备信息并入设置页右栏，生命周期挂在 settings 视图上
  registerView({
    id: 'settings',
    icon: 'codicon-settings-gear',
    label: '设置',
    init: () => {
      initSettingsView();
      initDeviceView();
    },
    onShow: refreshDeviceIdentifyState,
  });

  const tabsContainer = document.getElementById('titlebar-tabs');
  const gearBtn = document.getElementById('btn-settings-tab');
  if (tabsContainer) {
    const tabbar = initTabBar(
      tabsContainer,
      [
        { id: 'monitor', icon: 'codicon-pulse', label: '监控' },
        { id: 'pd', icon: 'codicon-zap', label: 'PD 分析' },
      ],
      showView,
    );
    onSelectionChange((id) => {
      tabbar.select(id);
      gearBtn?.classList.toggle('active', id === 'settings');
    });
  }
  gearBtn?.addEventListener('click', () => showView('settings'));

  // 命令栏浮出面板（面板 DOM 在 index.html，保持 ID 契约）
  /** @param {string} btnId @param {string} panelId */
  const wireFlyout = (btnId, panelId) => {
    const anchor = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (anchor && panel) createFlyout(anchor, panel);
  };
  wireFlyout('btn-flyout-display', 'flyout-display');
  wireFlyout('btn-flyout-autopause', 'flyout-autopause');
  wireFlyout('btn-flyout-temp', 'flyout-temp');

  initWindowControls();

  // 恢复上次的工作区（默认监控）
  restoreView(state.settings.activeView);
}

// ─── Event listeners ─────────────────────────────────────────────────────────

async function setupEventListener() {
  await listen('device-data', (/** @type {{ payload: import('./state.js').DeviceData }} */ event) => {
    addDataPoint(event.payload);
  });

  // PD 报文启动即监听（插拔瞬间的握手最有价值，不等用户打开 PD Tab）
  await listen('pd-data-batch', (/** @type {{ payload: unknown }} */ event) => {
    ingestPdBatch(event.payload);
  });

  await listen('device-disconnected', async () => {
    if (state.isConnected) {
      await disconnectDevice();
      markPdDisconnect();
      toast.warning('设备连接已断开');
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
  // 平台标记（CSS / windowcontrols 依据它分发 Windows decorum 或 Linux 自绘路径）
  const ua = navigator.userAgent;
  document.documentElement.setAttribute(
    'data-os',
    ua.includes('Windows') ? 'windows' : ua.includes('Mac OS') ? 'macos' : 'linux',
  );

  // 禁用右键菜单
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // 必须早于 loadSettings()，否则它对 select.value 的赋值发生在拦截器安装之前。
  enhanceSelects();

  await setupCloseConfirm();
  await loadSettings();
  initChart();
  setupChartToggles();
  setupControls();
  setupShell();

  // Clean recording state on load
  state.isRecording = false;

  await setupEventListener();
  await refreshDeviceList();

  updateTempUIVisibility();
});
