// @ts-check
/**
 * @file 应用入口 — Tauri API 导入、窗口关闭、UI 事件绑定、DOMContentLoaded 初始化。
 */

import {
  handleMonitorShown,
  initChart,
  refreshChartScales,
  scheduleChartUpdate,
  setRangeDragging,
  setSeriesFill,
  setSeriesVisible,
  updateCharts,
} from './chart.js';
import { panPermilleWindow } from './chart-window.js';
import { exportCSV, importCSV } from './csv.js';
import {
  adoptWindowFromPermille,
  clearAndResetStats,
  refreshMonitorDisplay,
  refreshRecordButton,
  refreshRecordLimitUI,
  scheduleStatsUpdate,
  startRecording,
  stopRecording,
  updateChartEmptyState,
  updateChartRange,
  updateDurationDisplay,
  updateEnergyDisplay,
  updateSampleRateStatus,
  updateSliderFill,
  updateStatsDisplay,
} from './data.js';
import {
  connectDevice,
  disconnectDevice,
  initializeDeviceStream,
  onDeviceSelect,
  refreshDeviceList,
  shutdownDeviceStream,
} from './device.js';
import { enhanceSelects } from './dropdown.js';
import { listSpoolRecoveries } from './file-io.js';
import { deviceSupportsControl } from './km003c-model.js';
import { clampLimitMb } from './recording-limit.js';
import { finalizeSpool, spoolRecordingStarted } from './recording-spool.js';
import {
  applyRealtimePanelWidth,
  applySampleRate,
  debouncedSaveSettings,
  echoApUnit,
  loadSettings,
  resetSettings,
  saveSettings,
} from './settings.js';
import { getActiveView, onSelectionChange, registerView, restoreView, showView } from './shell.js';
import { state } from './state.js';
import {
  connectTempService,
  disconnectTempService,
  setTempConnected,
  syncTempSourceUI,
  updateTempUIVisibility,
} from './temperature.js';
import { applyThemePreference } from './theme.js';
import { initCommandOverflow, syncAutoPauseUI, syncFollowLinkageUI, syncTempUI } from './ui/controlbar.js';
import { ask } from './ui/dialog.js';
import { createFlyout } from './ui/flyout.js';
import { createMenu } from './ui/menu.js';
import { initTabBar } from './ui/tabbar.js';
import { toast } from './ui/toast.js';
import { initWindowControls } from './ui/windowcontrols.js';
import { applyUiScale, clampUiScalePercent, previewUiScalePercent } from './ui-scale.js';
import { setSampleRateOption } from './utils.js';
import {
  applyPdSplitLayout,
  clearPdEntries,
  ingestPdBatch,
  initPdView,
  markPdDisconnect,
  syncPdView,
} from './views/pd.js';
import { initSettingsView, showSpoolRecoveries } from './views/settings-view.js';
import {
  handlePdmState,
  handleTriggerProgress,
  initTriggerView,
  syncTriggerConnection,
  syncTriggerView,
} from './views/trigger.js';
import { applyWindowStyle } from './window-style.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ─── Close confirmation ──────────────────────────────────────────────────────

let __isClosingWindow = false;
let __closeConfirmOpen = false;

/**
 * 退出流程唯一实现：确认 → 保存 → 排空并 ACK 末包 → 后端 destroy。
 *
 * destroy 不会重新派发 close-requested，因此既不需要注销监听器，也不需要备用关闭路径。
 * 自定义标题栏 ✕、⌘W/⌘Q 和 macOS 原生菜单退出都会汇聚到这里：
 * - 窗口关闭 / 快捷键走 onCloseRequested（先 preventDefault）；
 * - 原生退出（菜单 Quit 等不经窗口的路径）由 Rust 拦下首次 ExitRequested 后
 *   派发 `app-exit-requested`，同样进入本函数，末包校验通过后 shutdown 置位
 *   shutting_down，二次 ExitRequested 才真正放行。
 */
async function confirmAndExit() {
  // 重复触发时不再叠加弹窗：确认框是模态的，焦点已在其中
  if (__isClosingWindow || __closeConfirmOpen) return;

  __closeConfirmOpen = true;
  const confirmed = await ask('确定要退出吗？', { title: '确认退出', kind: 'warning' });
  __closeConfirmOpen = false;
  if (!confirmed) return;
  __isClosingWindow = true;

  // 设置里可能还压着一次未触发的防抖保存；saveSettings 自身已吞掉写盘异常。
  await saveSettings();

  try {
    await shutdownDeviceStream();
  } catch (e) {
    // 退出失败必须复位，否则窗口再也关不掉；只写 console 的话用户看到的是「点了没反应」。
    console.error('退出失败:', e);
    __isClosingWindow = false;
    toast.error(`退出失败: ${e}`);
  }
}

async function setupCloseConfirm() {
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  await appWindow.onCloseRequested((/** @type {any} */ event) => {
    event.preventDefault();
    void confirmAndExit();
  });
  await listen('app-exit-requested', () => {
    void confirmAndExit();
  });
  document.addEventListener('keydown', (event) => {
    if (document.documentElement.dataset.os !== 'macos' || !event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'w' && event.key.toLowerCase() !== 'q') return;
    event.preventDefault();
    void appWindow.close().catch(console.error);
  });
}

/**
 * 手动停止记录：UI 立即同步落定，读线程排空屏障在后台完成。
 * stopRecording 现返回可拒绝的屏障 Promise（暂停边界超时 / 代次切换），
 * 但停止动作本身不应向点击处冒泡为未处理的 rejection，这里统一吞掉并记录。
 */
function stopRecordingSafe() {
  void stopRecording().catch((error) => console.error('停止记录屏障失败:', error));
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
   * @param {boolean} [preview=false] 手柄拖动中：走 rAF 节流刷新，不立即提交绘制
   */
  function applyRangeValues(nextStart, nextEnd, leader, preview = false) {
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
    adoptWindowFromPermille();

    updateSliderFill();
    updateChartRange();
    // 拖动中曲线已经换窗，数字不能停在旧窗口；scheduleStatsUpdate 自带 250ms 节流。
    if (state.settings.statsRange) scheduleStatsUpdate();
    if (preview) {
      scheduleChartUpdate();
      return;
    }
    updateCharts();
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

    let handleDragActive = false;
    const beginHandleDrag = () => {
      handleDragActive = true;
      setRangeDragging(true);
    };
    const endHandleDrag = () => {
      if (!handleDragActive) return;
      handleDragActive = false;
      setRangeDragging(false);
      if (state.settings.statsRange) {
        updateStatsDisplay();
        updateEnergyDisplay();
      }
      updateCharts();
    };

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.focus();
      handle.setPointerCapture(event.pointerId);
      beginHandleDrag();

      const newValue = valueFromPointerEvent(event);
      if (which === 'start') applyRangeValues(newValue, rangeEnd.value, 'start', true);
      else applyRangeValues(rangeStart.value, newValue, 'end', true);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const newValue = valueFromPointerEvent(event);
      if (which === 'start') applyRangeValues(newValue, rangeEnd.value, 'start', true);
      else applyRangeValues(rangeStart.value, newValue, 'end', true);
    });

    handle.addEventListener('pointerup', endHandleDrag);
    handle.addEventListener('lostpointercapture', endHandleDrag);

    handle.addEventListener('keydown', (event) => {
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

  const sliderFill = /** @type {HTMLElement|null} */ (document.getElementById('slider-fill'));
  if (sliderFill && sliderContainer) {
    let panActive = false;
    let panOriginX = 0;
    let panOriginStart = 0;
    let panOriginEnd = 0;

    const endFillPan = () => {
      if (!panActive) return;
      panActive = false;
      sliderFill.classList.remove('is-panning');
      setRangeDragging(false);
      if (state.settings.statsRange) {
        updateStatsDisplay();
        updateEnergyDisplay();
      }
      updateCharts();
    };

    sliderFill.addEventListener('pointerdown', (event) => {
      if (state.settings.rangeEnd - state.settings.rangeStart >= 1000) return;
      event.preventDefault();
      sliderFill.setPointerCapture(event.pointerId);
      panActive = true;
      panOriginX = event.clientX;
      panOriginStart = Number.parseInt(rangeStart.value, 10);
      panOriginEnd = Number.parseInt(rangeEnd.value, 10);
      sliderFill.classList.add('is-panning');
      setRangeDragging(true);
    });

    sliderFill.addEventListener('pointermove', (event) => {
      if (!panActive || !sliderFill.hasPointerCapture(event.pointerId)) return;
      const width = sliderContainer.getBoundingClientRect().width;
      const delta = width > 0 ? ((event.clientX - panOriginX) / width) * 1000 : 0;
      const next = panPermilleWindow(panOriginStart, panOriginEnd, delta);
      applyRangeValues(next.start, next.end, 'start', true);
    });

    sliderFill.addEventListener('pointerup', endFillPan);
    sliderFill.addEventListener('lostpointercapture', endFillPan);
  }

  updateSliderFill();

  state.__setRangeControlsEnabled?.(true);

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

  btn('btn-connect', () => (state.isConnected ? disconnectDevice() : connectDevice()));
  btn('btn-refresh-devices', () => refreshDeviceList());

  const deviceSelect = document.getElementById('device-select');
  if (deviceSelect) deviceSelect.addEventListener('change', onDeviceSelect);

  btn('btn-record-toggle', () => (state.isRecording ? stopRecordingSafe() : void startRecording()));

  const statusRecord = document.getElementById('status-record');
  const toggleRecording = () => {
    if (!state.isConnected) return;
    if (state.isRecording) stopRecordingSafe();
    else void startRecording();
  };
  statusRecord?.addEventListener('click', () => toggleRecording());
  statusRecord?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleRecording();
  });

  // PD 视图在「跟随记录」开启时需要触发这几个监控侧动作。用注入而非让 pd.js
  // 直接 import data.js：那条边会把 chart.js / temperature.js 拖进 PD 的单元测试环境。
  state.__toggleRecording = () => (state.isRecording ? stopRecordingSafe() : startRecording());
  state.__clearMonitorData = () => clearAndResetStats();
  state.__markPdDisconnect = () => markPdDisconnect();

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

  initCommandOverflow({ exportCSV });

  initMonitorSplitter();

  btn('btn-reset-settings', async () => {
    const yes = await ask('确定要重置所有配置为默认值吗？', { title: '确认重置配置', kind: 'warning' });
    if (!yes) return;
    // 只有真的落盘才算「已恢复默认」；写盘失败由 settings.js 说明，这里不再报成功。
    if (await resetSettings()) toast.success('已恢复默认设置');
    applyPdSplitLayout();
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

  // 窗口风格只更新 CSS 属性；动作始终由真实 OS 决定。
  for (const choice of ['auto', 'windows', 'macos']) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(`window-style-${choice}`));
    input?.addEventListener('change', () => {
      if (!input.checked) return;
      state.settings.windowStyle = applyWindowStyle(choice);
      debouncedSaveSettings();
    });
  }

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

  // 单次记录上限（设置页 图表与记录）：换算点数门限，底栏剩余提示随之刷新
  const recordLimitEl = /** @type {HTMLInputElement|null} */ (document.getElementById('record-limit'));
  recordLimitEl?.addEventListener('change', () => {
    const mb = clampLimitMb(recordLimitEl.value);
    recordLimitEl.value = String(mb);
    state.settings.recordLimitMb = mb;
    refreshRecordLimitUI();
    debouncedSaveSettings();
  });

  // 临时恢复文件：关掉时收尾并删除当前缓存；记录中打开时立即新建
  const tempSpoolEl = /** @type {HTMLInputElement|null} */ (document.getElementById('recording-temp-spool'));
  tempSpoolEl?.addEventListener('change', () => {
    state.settings.recordingTempSpool = tempSpoolEl.checked;
    state.settings.autoSaveRecording = tempSpoolEl.checked;
    if (!tempSpoolEl.checked) void finalizeSpool();
    else if (state.isRecording) spoolRecordingStarted();
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
      echoApUnit();
      debouncedSaveSettings();
    });

    echoApUnit();
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

function initMonitorSplitter() {
  const handle = document.getElementById('monitor-splitter');
  const panel = document.querySelector('.realtime-panel');
  if (!(handle instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;

  /** @type {number|null} */
  let pointer = null;
  let originLeft = 0;
  let originPref = state.settings.realtimePanelWidth;
  let originVisual = 0;
  let pendingWidth = originPref;
  let raf = 0;

  const visualWidth = () => Math.round(panel.getBoundingClientRect().width);
  const widthCap = () => {
    const cap = Number.parseFloat(getComputedStyle(panel).maxWidth);
    return Number.isFinite(cap) ? cap : 360;
  };

  const flushVisual = () => {
    raf = 0;
    applyRealtimePanelWidth(pendingWidth, { persistAria: false, commit: false });
  };

  const endDrag = () => {
    if (!state.__layoutResizing) return;
    // 先释放再提交：图表的 ResizeObserver 只认这个标志，晚一行清掉就可能永久不再定尺。
    state.__layoutResizing = false;
    pointer = null;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    const visual = visualWidth();
    // 窄窗 max-width 卡住时拖动不会改变可视宽度，不能把鼠标位移写进偏好，
    // 否则放大窗口后侧栏会跟着被改掉。
    if (Math.abs(visual - originVisual) < 1) {
      applyRealtimePanelWidth(originPref);
    } else {
      applyRealtimePanelWidth(visual);
      debouncedSaveSettings();
    }
    handleMonitorShown();
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointer = e.pointerId;
    originLeft = panel.getBoundingClientRect().left;
    originPref = state.settings.realtimePanelWidth;
    originVisual = visualWidth();
    pendingWidth = originPref;
    handle.setPointerCapture(e.pointerId);
    state.__layoutResizing = true;
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (pointer === null) return;
    pendingWidth = e.clientX - originLeft;
    if (!raf) raf = requestAnimationFrame(flushVisual);
  });
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  // 捕获被第二个指针或其他手柄抢走时浏览器只发这个，与 :337 / :407 两个时间轴手柄保持一致。
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const visual = visualWidth();
    const next = visual + (e.key === 'ArrowRight' ? 8 : -8);
    const clamped = Math.round(Math.min(widthCap(), Math.max(200, next)));
    if (clamped === visual) return;
    applyRealtimePanelWidth(clamped);
    handleMonitorShown();
    debouncedSaveSettings();
  });
}

// ─── Shell（多 Tab 工作区 + 标题栏） ─────────────────────────────────────────

/** @type {ReturnType<typeof initTabBar>|null} */
let tabbar = null;
/** 上次停在协议控制页：设备列表就绪、确认选中的是 POWER-Z 后再切过去。 */
let restoreTriggerPending = false;

/** 下拉框当前指向的设备（已连接时就是连接中的那台）。 */
function selectedDeviceInfo() {
  return state.connectedDevice ?? state.deviceList.find((d) => d.path === state.selectedDevicePath) ?? null;
}

/** 协议控制 Tab 只在选中支持控制的设备时出现；隐藏时若正停在该页则回到监控。 */
function syncControlTab() {
  const device = selectedDeviceInfo();
  const visible = deviceSupportsControl(device);
  tabbar?.setHidden('trigger', !visible);
  const rateSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
  const highRate = state.isConnected && state.connectedDevice?.family === 'km003c';
  const highRateOption = /** @type {HTMLOptionElement|null} */ (rateSelect?.querySelector('option[value="1"]') ?? null);
  if (highRateOption) highRateOption.hidden = !highRate;
  if (!highRate && state.settings.sampleRate === 1) {
    state.settings.sampleRate = 10;
    state.dataIntervalMs = 10;
    if (rateSelect) setSampleRateOption(rateSelect, 10);
    updateSampleRateStatus();
  }
  if (visible && restoreTriggerPending) {
    restoreTriggerPending = false;
    showView('trigger');
  } else if (!visible && getActiveView() === 'trigger') {
    showView('monitor');
  }
}

function setupShell() {
  const showMonitor = () => {
    refreshMonitorDisplay();
    handleMonitorShown();
  };
  registerView({ id: 'monitor', icon: 'pulse', label: '监控', onShow: showMonitor });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshMonitorDisplay();
  });
  registerView({ id: 'pd', icon: 'flash', label: 'PD 分析', init: initPdView, onShow: syncPdView });
  registerView({ id: 'trigger', icon: 'options', label: '协议控制', init: initTriggerView, onShow: syncTriggerView });
  // 设备信息并入设置页右栏，生命周期挂在 settings 视图上
  registerView({
    id: 'settings',
    icon: 'settings',
    label: '设置',
    init: initSettingsView,
  });

  const tabsContainer = document.getElementById('titlebar-tabs');
  const gearBtn = document.getElementById('btn-settings-tab');
  if (tabsContainer) {
    const bar = initTabBar(
      tabsContainer,
      [
        { id: 'monitor', icon: 'pulse', label: '监控' },
        { id: 'pd', icon: 'flash', label: 'PD 分析' },
        { id: 'trigger', icon: 'options', label: '协议控制', hidden: true },
      ],
      showView,
    );
    tabbar = bar;
    onSelectionChange((id) => {
      bar.select(id);
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

  applyWindowStyle(state.settings.windowStyle);
  initWindowControls();

  // 恢复上次的工作区（默认监控）。协议控制页要等设备列表确认是 POWER-Z 才出现，
  // 先停在监控：activeView 同时决定监控显示是否刷新，不能让它指着一个没显示的页。
  if (state.settings.activeView === 'trigger') {
    restoreTriggerPending = true;
    state.settings.activeView = 'monitor';
  }
  restoreView(state.settings.activeView);
  document.addEventListener('witrn:device-selection', syncControlTab);
}

// ─── Event listeners ─────────────────────────────────────────────────────────

async function setupEventListener() {
  await initializeDeviceStream();

  // PD 报文启动即监听（插拔瞬间的握手最有价值，不等用户打开 PD Tab）
  await listen('pd-data-batch', (/** @type {{ payload: unknown }} */ event) => {
    ingestPdBatch(event.payload);
  });

  // 协议控制的进度与 PDM 状态：视图没打开时也要收，命令可能在别的 Tab 上结束。
  await listen('km003c-trigger-progress', (/** @type {{ payload: unknown }} */ event) => {
    handleTriggerProgress(event.payload);
  });
  await listen('km003c-pdm-state', (/** @type {{ payload: unknown }} */ event) => {
    handlePdmState(event.payload);
  });
  await listen('km003c-high-rate', (/** @type {{ payload: { ok?: boolean; message?: string } }} */ event) => {
    if (event.payload?.ok === false) {
      void applySampleRate(10);
      toast.warning(`POWER-Z 高速采样不可用，已退回 100 次/秒：${event.payload.message ?? ''}`);
    }
  });
  document.addEventListener('witrn:monitor-changed', syncTriggerConnection);

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
  // theme-boot 已按 UA 同步写入 data-os；这里用原生探测覆盖为权威值。
  // 探测失败不能阻断后续初始化（否则关闭确认、设置加载全部跳过），回退到 UA 值。
  try {
    const platform = await invoke('get_runtime_platform');
    window.__WITRN_BOOT__?.mark('platformProbed');
    if (platform) document.documentElement.setAttribute('data-os', platform);
  } catch (error) {
    console.error('运行时平台探测失败，沿用首屏 UA 判定:', error);
  }

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
  applyPdSplitLayout();
  window.addEventListener('resize', applyPdSplitLayout);
  updateSampleRateStatus();
  updateChartEmptyState();
  updateDurationDisplay();

  // Clean recording state on load
  state.isRecording = false;

  await setupEventListener();
  await refreshDeviceList();
  // Scan asynchronously so startup stays quiet and does not block device enumeration.
  void listSpoolRecoveries()
    .then((entries) => {
      showSpoolRecoveries(entries);
      if (entries.length) toast.info(`发现 ${entries.length} 份可恢复的临时记录，请在设置页查看。`);
    })
    .catch((error) => console.error('扫描临时恢复文件失败:', error));
  // 列表里没有 POWER-Z 时不再等待恢复协议控制页。
  restoreTriggerPending = false;
  window.__WITRN_BOOT__?.mark('appReady');

  updateTempUIVisibility();
});
