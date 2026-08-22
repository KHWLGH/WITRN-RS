// @ts-check
/**
 * @file 数据入库、统计计算、UI 显示更新、录制控制、图表/统计重置。
 */

import { scheduleChartUpdate, setChartXWindow, syncChartSeries, updateCharts } from './chart.js';
import { nextRecordingX } from './measurement.js';
import { emptyChartColumns, setChartColumns, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { syncRecordUI } from './ui/controlbar.js';
import { formatRelativeHMS } from './utils.js';

/** @param {string} cmd @param {Record<string, unknown>} [args] */
function invokeCmd(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return Promise.resolve(null);
  return invoke(cmd, args);
}

/** 按当前状态刷新命令栏的记录按钮（开始 / 继续 / 暂停）。 */
export function refreshRecordButton() {
  syncRecordUI({
    connected: state.isConnected,
    recording: state.isRecording,
    hasData: state.chartData.timestamps.length > 0,
    followPd: state.settings.pdFollowRecording,
  });
}

// ─── Data ingestion ──────────────────────────────────────────────────────────

/**
 * 接收一条设备数据，更新存储、统计、图表。
 * @param {import('./state.js').DeviceData} data
 */
export function addDataPoint(data) {
  const now = new Date();

  // 有符号电流：开启后保留方向（正=正向 / 负=反向）；关闭时按旧行为记录绝对值。
  // 功率恒取绝对值（电压非负，功率符号与电流一致，不损失信息）。
  const currentValue = state.settings.signedCurrent ? data.current : Math.abs(data.current);
  const powerAbs = Math.abs(data.power);
  const hidTemp = Number.isFinite(data.temperature) ? /** @type {number} */ (data.temperature) : Number.NaN;
  let tempValue = Number.NaN;
  if (state.isTempConnected) {
    tempValue = state.settings.tempSource === 'device' ? hidTemp : (state.currentTemp ?? Number.NaN);
  }

  const realtime = { ...data, current: currentValue, power: powerAbs, temp: tempValue };
  lastRealtime = realtime;

  // 仅录制模式：未录制时只更新实时显示
  if (!state.isRecording) {
    updateRealtimeDisplay(realtime);
    const el = document.getElementById('data-count');
    if (el) el.textContent = String(state.chartData.timestamps.length);
    return;
  }

  /** @param {number|undefined} v */
  const lineVoltage = (v) =>
    Number.isFinite(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= 60
      ? /** @type {number} */ (v)
      : Number.NaN;
  const dpValue = lineVoltage(data.dp);
  const dnValue = lineVoltage(data.dn);
  const cc1Value = Number.isFinite(data.cc1) ? /** @type {number} */ (data.cc1) : Number.NaN;
  const cc2Value = Number.isFinite(data.cc2) ? /** @type {number} */ (data.cc2) : Number.NaN;

  const cols = state.chartSeries;
  const nowMs = now.getTime();
  const activeElapsed = state.recordingStartTime === null ? 0 : (nowMs - state.recordingStartTime) / 1000;
  let relSeconds = state.recordingBaseSeconds + Math.max(0, activeElapsed);
  const prevX = cols.x.length > 0 ? cols.x.at(-1) : Number.NaN;
  relSeconds = nextRecordingX(prevX, relSeconds, state.settings.sampleRate);

  cols.timestamps.push(nowMs);
  cols.voltage.push(data.voltage);
  cols.current.push(currentValue);
  cols.power.push(powerAbs);
  cols.temp.push(tempValue);
  cols.dp.push(dpValue);
  cols.dn.push(dnValue);
  cols.cc1.push(cc1Value);
  cols.cc2.push(cc2Value);
  cols.x.push(relSeconds);

  updateStats('voltage', data.voltage);
  updateStats('current', currentValue);
  updateStats('power', powerAbs);
  if (state.isTempConnected && Number.isFinite(tempValue)) {
    updateStats('temp', tempValue);
  }

  // 能量累计用相对秒（与范围统计同口径）；暂停空档不在 x 里。
  if (state.energy.lastX !== null) {
    const dt = (relSeconds - state.energy.lastX) / 3600;
    if (dt >= 0) {
      state.energy.wh += powerAbs * dt;
      state.energy.mah += Math.abs(currentValue) * 1000 * dt;
    }
  }
  state.energy.lastX = relSeconds;

  scheduleStatsUpdate();
  // 全量模式的能量读数是 O(1)，逐点刷新更跟手；范围模式要重扫可见区间，交给上面的节流路径。
  if (!state.settings.statsRange) updateEnergyDisplay();

  scheduleRangeUi();

  // Auto Pause 逻辑（电流/功率阈值恒按幅值比较，与方向设置无关）
  if (state.isRecording && state.autoPauseSettings.enabled && state.autoPauseSettings.basis !== 'none') {
    let value;
    if (state.autoPauseSettings.basis === 'voltage') {
      value = data.voltage;
    } else if (state.autoPauseSettings.basis === 'current') {
      value = Math.abs(currentValue);
    } else {
      value = powerAbs;
    }

    if (value <= state.autoPauseSettings.condition) {
      if (!state.autoPauseSettings.triggerStartTime) {
        state.autoPauseSettings.triggerStartTime = Date.now();
      } else {
        const elapsed = (Date.now() - state.autoPauseSettings.triggerStartTime) / 1000;
        if (elapsed >= state.autoPauseSettings.duration) {
          stopRecording();
          state.autoPauseSettings.triggerStartTime = null;
        }
      }
    } else {
      state.autoPauseSettings.triggerStartTime = null;
    }
  }

  scheduleChartUpdate();
}

// ─── Slider / range ──────────────────────────────────────────────────────────

/** 更新滑块填充条的位置和宽度。 */
export function updateSliderFill() {
  const start = state.settings.rangeStart / 10;
  const end = state.settings.rangeEnd / 10;
  const fill = document.getElementById('slider-fill');
  if (fill?.style) {
    fill.style.left = `${start}%`;
    fill.style.width = `${end - start}%`;
  }

  const handleStart = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-start'));
  const handleEnd = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-end'));
  if (handleStart?.style) {
    handleStart.style.left = `${start}%`;
    handleStart.setAttribute('aria-valuenow', String(start));
  }
  if (handleEnd?.style) {
    handleEnd.style.left = `${end}%`;
    handleEnd.setAttribute('aria-valuenow', String(end));
  }
}

/** 根据滑块值更新主图表的可见范围。 */
export function updateChartRange() {
  const totalPoints = state.chartData.timestamps.length;
  if (totalPoints === 0) {
    const el1 = document.getElementById('range-start-time');
    const el2 = document.getElementById('range-end-time');
    const el3 = document.getElementById('range-duration');
    if (el1) el1.textContent = '--';
    if (el2) el2.textContent = '--';
    if (el3) el3.textContent = '无数据';
    return;
  }

  const { startIndex, endIndex } = getVisibleDataRange();

  // 直接取序列的 x 坐标（与图表同一坐标系）。
  // 不能用时间戳差值换算——差值恒从 0 起，而导入的 CSV 序列可能从非零时刻开始，
  // 错位会让窗口大于数据范围，在图表前部凭空出现空白。
  const xs = state.chartSeries.x.buf;
  const startSeconds = Number.isFinite(xs[startIndex]) ? xs[startIndex] : 0;
  const endSeconds = Number.isFinite(xs[endIndex]) ? xs[endIndex] : 0;

  // 窗口与数据齐平，不加人为留白（零跨度情况由 chart.js 的 range 函数保护）
  setChartXWindow(startSeconds, endSeconds);

  const el1 = document.getElementById('range-start-time');
  const el2 = document.getElementById('range-end-time');
  if (el1) el1.textContent = formatRelativeHMS(startSeconds);
  if (el2) el2.textContent = formatRelativeHMS(endSeconds);

  const points = endIndex - startIndex + 1;
  const durationSec = Math.max(0, endSeconds - startSeconds);
  const durationText = formatRelativeHMS(durationSec);
  const el3 = document.getElementById('range-duration');
  if (el3) el3.textContent = `时长: ${durationText} (${points}点)`;
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * 更新指定字段的统计值。
 * @param {'voltage'|'current'|'power'|'temp'} field
 * @param {number} value
 */
export function updateStats(field, value) {
  const stat = state.stats[field];
  if (!stat || !Number.isFinite(value)) return;

  if (value < stat.min) stat.min = value;
  if (value > stat.max) stat.max = value;
  stat.sum += value;
  stat.count += 1;
}

// ─── Display updates ─────────────────────────────────────────────────────────

/**
 * 更新实时数据显示面板。
 * @param {{ voltage: number, current: number, power: number, temp: number, dp?: number, dn?: number, cc1?: number, cc2?: number }} data
 */
export function updateRealtimeDisplay(data) {
  const vEl = document.getElementById('rt-voltage');
  const cEl = document.getElementById('rt-current');
  const pEl = document.getElementById('rt-power');
  if (vEl) vEl.textContent = data.voltage.toFixed(4);
  // 电流数值恒显示幅值，方向由箭头表达（需求：不用正负号）
  if (cEl) cEl.textContent = Math.abs(data.current).toFixed(4);
  if (pEl) pEl.textContent = data.power.toFixed(4);

  const dirEl = /** @type {HTMLElement|null} */ (document.getElementById('rt-current-dir'));
  if (dirEl) {
    const showDir = state.settings.signedCurrent && Number.isFinite(data.current) && data.current !== 0;
    dirEl.hidden = !showDir;
    if (showDir) {
      dirEl.classList?.toggle('codicon-arrow-small-right', data.current > 0);
      dirEl.classList?.toggle('codicon-arrow-small-left', data.current < 0);
      dirEl.title = data.current > 0 ? '正向电流' : '反向电流';
    }
  }

  if (state.isTempConnected && Number.isFinite(data.temp)) {
    const tEl = document.getElementById('rt-temp');
    if (tEl) tEl.textContent = data.temp.toFixed(1);
  } else if (state.isTempConnected) {
    const tEl = document.getElementById('rt-temp');
    if (tEl) tEl.textContent = '--';
  }

  /** @param {string} id @param {number|undefined} val */
  const setSignal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = Number.isFinite(val) ? /** @type {number} */ (val).toFixed(2) : '--';
  };
  setSignal('rt-dp', data.dp);
  setSignal('rt-dn', data.dn);
  setSignal('rt-cc1', data.cc1);
  setSignal('rt-cc2', data.cc2);
}

/**
 * 获取当前可见数据范围的索引。
 * @returns {{ startIndex: number, endIndex: number }}
 */
export function getVisibleDataRange() {
  const totalPoints = state.chartData.timestamps.length;
  if (totalPoints === 0) return { startIndex: 0, endIndex: 0 };

  // rangeStart/rangeEnd 已限定在 0..1000，只需处理上界取到末尾以及首尾交叉的情况。
  let startIndex = Math.floor((totalPoints * state.settings.rangeStart) / 1000);
  let endIndex = Math.floor((totalPoints * state.settings.rangeEnd) / 1000);

  if (endIndex >= totalPoints) endIndex = totalPoints - 1;
  if (startIndex > endIndex) startIndex = endIndex;

  return { startIndex, endIndex };
}

/**
 * @typedef {{
 *   rangeStart: number, rangeEnd: number,
 *   startIndex: number, endIndex: number, len: number,
 *   minV: number, maxV: number, minC: number, maxC: number,
 *   minP: number, maxP: number, minT: number, maxT: number,
 *   sumP: number, countP: number, sumT: number, countT: number,
 *   wh: number, mah: number,
 * }} RangeStatsCache
 */
/** @type {RangeStatsCache|null} */
let rangeStatsCache = null;

/** @param {RangeStatsCache} cache @param {number} i */
function foldRangePoint(cache, i) {
  const cols = state.chartSeries;
  const v = cols.voltage.buf[i];
  const c = cols.current.buf[i];
  const p = cols.power.buf[i];
  const t = cols.temp.buf[i];
  if (v < cache.minV) cache.minV = v;
  if (v > cache.maxV) cache.maxV = v;
  if (c < cache.minC) cache.minC = c;
  if (c > cache.maxC) cache.maxC = c;
  if (p < cache.minP) cache.minP = p;
  if (p > cache.maxP) cache.maxP = p;
  cache.sumP += p;
  cache.countP += 1;
  if (Number.isFinite(t)) {
    if (t < cache.minT) cache.minT = t;
    if (t > cache.maxT) cache.maxT = t;
    cache.sumT += t;
    cache.countT += 1;
  }
  if (i <= cache.startIndex) return;
  const dt = (cols.x.buf[i] - cols.x.buf[i - 1]) / 3600;
  const currentAbs = Math.abs(c);
  const powerAbs = Math.abs(p);
  if (dt < 0 || !Number.isFinite(dt) || !Number.isFinite(currentAbs) || !Number.isFinite(powerAbs)) return;
  cache.wh += powerAbs * dt;
  cache.mah += currentAbs * 1000 * dt;
}

/** 范围统计：窗口未变则复用；全历史窗口增长时只折入新尾段。 */
function getRangeStats() {
  const cols = state.chartSeries;
  const len = cols.x.length;
  if (len === 0) return null;
  const { startIndex, endIndex } = getVisibleDataRange();
  const rs = state.settings.rangeStart;
  const re = state.settings.rangeEnd;
  const cache = rangeStatsCache;
  if (
    cache &&
    cache.rangeStart === rs &&
    cache.rangeEnd === re &&
    cache.startIndex === startIndex &&
    cache.endIndex === endIndex &&
    cache.len === len
  ) {
    return cache;
  }
  if (
    cache &&
    cache.rangeStart === rs &&
    cache.rangeEnd === re &&
    cache.startIndex === 0 &&
    startIndex === 0 &&
    cache.endIndex === cache.len - 1 &&
    endIndex === len - 1 &&
    len > cache.len
  ) {
    for (let i = cache.len; i < len; i++) foldRangePoint(cache, i);
    cache.endIndex = endIndex;
    cache.len = len;
    return cache;
  }
  /** @type {RangeStatsCache} */
  const next = {
    rangeStart: rs,
    rangeEnd: re,
    startIndex,
    endIndex,
    len,
    minV: Infinity,
    maxV: -Infinity,
    minC: Infinity,
    maxC: -Infinity,
    minP: Infinity,
    maxP: -Infinity,
    minT: Infinity,
    maxT: -Infinity,
    sumP: 0,
    countP: 0,
    sumT: 0,
    countT: 0,
    wh: 0,
    mah: 0,
  };
  for (let i = startIndex; i <= endIndex; i++) foldRangePoint(next, i);
  rangeStatsCache = next;
  return next;
}

/** 更新统计显示面板（支持范围模式）。 */
export function updateStatsDisplay() {
  let displayStats = state.stats;
  let powerAvg = state.stats.power.count > 0 ? state.stats.power.sum / state.stats.power.count : null;
  let tempAvg = state.stats.temp.count > 0 ? state.stats.temp.sum / state.stats.temp.count : null;
  let displayPowerAvg = powerAvg;
  let displayTempAvg = tempAvg;

  if (state.settings.statsRange && state.chartSeries.x.length > 0) {
    const range = getRangeStats();
    if (range) {
      displayStats = {
        voltage: { min: range.minV, max: range.maxV, sum: 0, count: 0 },
        current: { min: range.minC, max: range.maxC, sum: 0, count: 0 },
        power: { min: range.minP, max: range.maxP, sum: 0, count: 0 },
        temp: { min: range.minT, max: range.maxT, sum: 0, count: 0 },
      };
      powerAvg = range.countP > 0 ? range.sumP / range.countP : null;
      tempAvg = range.countT > 0 ? range.sumT / range.countT : null;
      displayPowerAvg = powerAvg;
      displayTempAvg = tempAvg;
    }
  }

  /** @param {string} id @param {number} val @param {number} [decimals=3] */
  const setText = (id, val, decimals = 3) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val === Infinity || val === -Infinity ? '--' : val.toFixed(decimals);
  };

  setText('min-voltage', displayStats.voltage.min);
  setText('max-voltage', displayStats.voltage.max);
  setText('min-current', displayStats.current.min);
  setText('max-current', displayStats.current.max);
  setText('min-power', displayStats.power.min);
  setText('max-power', displayStats.power.max);

  const avgPowerEl = document.getElementById('avg-power');
  if (avgPowerEl) avgPowerEl.textContent = displayPowerAvg !== null ? displayPowerAvg.toFixed(3) : '--';

  const tempStats = displayStats.temp || state.stats.temp;
  setText('min-temp', tempStats.min, 1);
  setText('max-temp', tempStats.max, 1);

  const avgTempEl = document.getElementById('avg-temp');
  if (avgTempEl) avgTempEl.textContent = displayTempAvg !== null ? displayTempAvg.toFixed(1) : '--';
}

/** 更新能量显示（支持范围模式）。 */
export function updateEnergyDisplay() {
  let { wh, mah } = state.energy;

  // 范围模式下累计量也只统计选中区间，与最值/均值口径一致。
  if (state.settings.statsRange && state.chartSeries.x.length > 0) {
    const range = getRangeStats();
    if (range) {
      wh = range.wh;
      mah = range.mah;
    }
  }

  const whEl = document.getElementById('rt-energy');
  const mahEl = document.getElementById('rt-capacity');
  if (whEl) whEl.textContent = wh.toFixed(4);
  if (mahEl) mahEl.textContent = mah.toFixed(2);
}

// ─── Throttled stats refresh ─────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let __statsUpdateTimer = null;
/** @type {boolean} */
let __rangeUiPending = false;
/** @type {Parameters<typeof updateRealtimeDisplay>[0]|null} */
let lastRealtime = null;

/**
 * 范围标签与点数：跟 rAF 走，不跟每个采样点走。
 */
export function scheduleRangeUi() {
  if (__rangeUiPending) return;
  __rangeUiPending = true;
  requestAnimationFrame(() => {
    __rangeUiPending = false;
    if (lastRealtime) updateRealtimeDisplay(lastRealtime);
    updateChartRange();
    const el = document.getElementById('data-count');
    if (el) el.textContent = String(state.chartSeries.x.length);
  });
}

/**
 * 节流版 updateStatsDisplay（含能量显示）。
 * 范围统计需要 O(可见点数) 的遍历，流式采样不需要每个点都同步重扫。
 * 250ms 的上限刷新间隔保持 UI 可读性，同时避免长录制时主线程被统计占满。
 */
export function scheduleStatsUpdate() {
  if (__statsUpdateTimer !== null) return;
  __statsUpdateTimer = setTimeout(() => {
    __statsUpdateTimer = null;
    updateStatsDisplay();
    updateEnergyDisplay();
  }, 250);
}

// ─── Reset functions ─────────────────────────────────────────────────────────

/** 重置统计数据。 */
export function resetStats() {
  state.stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  updateStatsDisplay();
}

/** 重置能量累计。 */
export function resetEnergy() {
  state.energy = { wh: 0, mah: 0, lastX: null };
  updateEnergyDisplay();
}

/** 把实时卡片清成占位，避免清空 / 导入后仍显示上一轮活点。 */
export function resetRealtimeCards() {
  lastRealtime = null;
  /** @param {string} id */
  const dash = (id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '--';
  };
  dash('rt-voltage');
  dash('rt-current');
  dash('rt-power');
  dash('rt-temp');
  dash('rt-dp');
  dash('rt-dn');
  dash('rt-cc1');
  dash('rt-cc2');
  const dirEl = document.getElementById('rt-current-dir');
  if (dirEl) dirEl.hidden = true;
}

/** 清空图表数据和相关状态。 */
export function clearChart() {
  if (state.isRecording) stopRecording();
  setChartColumns(emptyChartColumns());
  rangeStatsCache = null;
  state.lastRecordingStartTime = null;
  state.recordingBaseSeconds = 0;
  resetRealtimeCards();

  if (!state.isTempConnected) {
    state.hasTempData = false;
    updateTempUIVisibility();
  }

  setChartXWindow(null, null);
  syncChartSeries();
  updateCharts();

  // 数据清空后按钮从「继续记录」退回「开始记录」
  refreshRecordButton();

  const el = document.getElementById('data-count');
  if (el) el.textContent = '0';
}

// ─── Recording control ───────────────────────────────────────────────────────

/** 开始录制。先打开后端 PD 门再置本地标志，避免点开始后立刻插充电器丢握手。 */
export async function startRecording() {
  if (!state.isConnected) {
    console.warn('Attempted to start recording while not connected');
    return;
  }
  if (state.isRecording) return;

  try {
    await invokeCmd('set_pd_capture_enabled', { enabled: true });
  } catch (e) {
    console.error(e);
  }
  if (!state.isConnected || state.isRecording) return;

  state.isRecording = true;
  const now = Date.now();
  state.recordingStartTime = now;
  if (state.chartData.timestamps.length === 0) {
    state.lastRecordingStartTime = now;
    state.recordingBaseSeconds = 0;
  } else {
    const lastX = state.chartSeries.x.at(-1);
    state.recordingBaseSeconds =
      (Number.isFinite(lastX) ? lastX : 0) + Math.max(state.settings.sampleRate / 1000, 0.001);
    if (state.lastRecordingStartTime === null) state.lastRecordingStartTime = state.chartData.timestamps.at(0);
  }
  // 暂停期间不属于下一段能量积分区间。
  state.energy.lastX = null;
  state.autoPauseSettings.triggerStartTime = null;

  // 录制跟最新数据走：先前缩放过的选区百分比会随着点数增长漂到错误窗口。
  state.settings.rangeStart = 0;
  state.settings.rangeEnd = 1000;
  updateSliderFill();
  updateChartRange();

  const el = document.getElementById('record-status');
  if (el) el.textContent = '记录中...';

  refreshRecordButton();
  const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
  if (btnClear) btnClear.disabled = true;

  state.__setRangeControlsEnabled?.(false);
  // 通知 PD 视图等订阅方（可选调用：node 测试的 document stub 没有 dispatchEvent）
  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
}

/** 停止（暂停）录制。 */
export function stopRecording() {
  if (!state.isRecording) return;

  state.isRecording = false;
  state.recordingStartTime = null;
  state.energy.lastX = null;
  state.autoPauseSettings.triggerStartTime = null;

  const el = document.getElementById('record-status');
  if (el) el.textContent = '停止';

  refreshRecordButton();
  const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
  if (btnClear) btnClear.disabled = false;

  state.__setRangeControlsEnabled?.(true);
  // 预算跳过的帧在暂停时补一张全质量图
  updateCharts();

  // 跟随记录关闭时采集门保持开；开启时与本地 isRecording 一起关掉。
  void invokeCmd('set_pd_capture_enabled', { enabled: !state.settings.pdFollowRecording });

  // 单一咽喉点：手动停止 / 自动暂停 / 拔设备 / CSV 导入引发的停止都会走到这里
  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
}

/** 清空图表并重置统计和能量。 */
export function clearAndResetStats() {
  clearChart();
  resetStats();
  resetEnergy();
}
