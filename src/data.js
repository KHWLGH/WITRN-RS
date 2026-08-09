// @ts-check
/**
 * @file 数据入库、统计计算、UI 显示更新、录制控制、图表/统计重置。
 */

import { scheduleChartUpdate, setChartXWindow, syncChartSeries, updateCharts } from './chart.js';
import { state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { formatRelativeHMS } from './utils.js';

// ─── Data ingestion ──────────────────────────────────────────────────────────

/**
 * 接收一条设备数据，更新存储、统计、图表。
 * @param {import('./state.js').DeviceData} data
 */
export function addDataPoint(data) {
  const now = new Date();

  const currentAbs = Math.abs(data.current);
  const powerAbs = Math.abs(data.power);
  const tempValue =
    typeof state.currentTemp === 'number' && Number.isFinite(state.currentTemp) ? state.currentTemp : Number.NaN;

  // 仅录制模式：未录制时只更新实时显示
  if (!state.isRecording) {
    updateRealtimeDisplay({ ...data, current: currentAbs, power: powerAbs, temp: tempValue });
    const el = document.getElementById('data-count');
    if (el) el.textContent = String(state.chartData.timestamps.length);
    return;
  }

  const nowMs = now.getTime();
  const activeElapsed = state.recordingStartTime === null ? 0 : (nowMs - state.recordingStartTime) / 1000;
  const relSeconds = state.recordingBaseSeconds + Math.max(0, activeElapsed);

  // 全精度原始数据
  state.chartData.timestamps.push(nowMs);
  state.chartData.voltage.push(data.voltage);
  state.chartData.current.push(currentAbs);
  state.chartData.power.push(powerAbs);
  state.chartData.temp.push(tempValue);

  // x/y 序列（uPlot 列式格式，与 chartData 同步追加）
  state.chartSeries.x.push(relSeconds);
  state.chartSeries.voltage.push(data.voltage);
  state.chartSeries.current.push(currentAbs);
  state.chartSeries.power.push(powerAbs);
  state.chartSeries.temp.push(tempValue);

  updateChartRange();

  updateStats('voltage', data.voltage);
  updateStats('current', currentAbs);
  updateStats('power', powerAbs);
  if (state.isTempConnected && Number.isFinite(tempValue)) {
    updateStats('temp', tempValue);
  }

  // 能量累计
  if (state.energy.lastTimestamp !== null) {
    const dt = (nowMs - state.energy.lastTimestamp) / 3600000;
    if (dt >= 0) {
      state.energy.wh += powerAbs * dt;
      state.energy.mah += currentAbs * 1000 * dt;
    }
  }
  state.energy.lastTimestamp = now.getTime();

  updateRealtimeDisplay({ ...data, current: currentAbs, power: powerAbs, temp: tempValue });
  scheduleStatsUpdate();
  updateEnergyDisplay();

  const dataCountEl = document.getElementById('data-count');
  if (dataCountEl) dataCountEl.textContent = String(state.chartData.timestamps.length);

  // Auto Pause 逻辑
  if (state.isRecording && state.autoPauseSettings.enabled && state.autoPauseSettings.basis !== 'none') {
    let value;
    if (state.autoPauseSettings.basis === 'voltage') {
      value = data.voltage;
    } else if (state.autoPauseSettings.basis === 'current') {
      value = currentAbs;
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
  if (fill) {
    fill.style.left = `${start}%`;
    fill.style.width = `${end - start}%`;
  }

  const handleStart = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-start'));
  const handleEnd = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-end'));
  if (handleStart) {
    handleStart.style.left = `${start}%`;
    handleStart.setAttribute('aria-valuenow', String(start));
  }
  if (handleEnd) {
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
  const xs = state.chartSeries.x;
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
 * @param {{ voltage: number, current: number, power: number, temp: number }} data
 */
export function updateRealtimeDisplay(data) {
  const vEl = document.getElementById('rt-voltage');
  const cEl = document.getElementById('rt-current');
  const pEl = document.getElementById('rt-power');
  if (vEl) vEl.textContent = data.voltage.toFixed(4);
  if (cEl) cEl.textContent = data.current.toFixed(4);
  if (pEl) pEl.textContent = data.power.toFixed(4);
  if (state.isTempConnected && Number.isFinite(data.temp)) {
    const tEl = document.getElementById('rt-temp');
    if (tEl) tEl.textContent = data.temp.toFixed(1);
  } else if (state.isTempConnected) {
    const tEl = document.getElementById('rt-temp');
    if (tEl) tEl.textContent = '--';
  }
}

/**
 * 获取当前可见数据范围的索引。
 * @returns {{ startIndex: number, endIndex: number }}
 */
export function getVisibleDataRange() {
  const totalPoints = state.chartData.timestamps.length;
  if (totalPoints === 0) return { startIndex: 0, endIndex: 0 };

  let startIndex = Math.floor((totalPoints * state.settings.rangeStart) / 1000);
  let endIndex = Math.floor((totalPoints * state.settings.rangeEnd) / 1000);

  if (startIndex < 0) startIndex = 0;
  if (endIndex >= totalPoints) endIndex = totalPoints - 1;
  if (startIndex > endIndex) startIndex = endIndex;

  return { startIndex, endIndex };
}

/** 更新统计显示面板（支持范围模式）。 */
export function updateStatsDisplay() {
  let displayStats = state.stats;
  let powerAvg = state.stats.power.count > 0 ? state.stats.power.sum / state.stats.power.count : null;
  let tempAvg = state.stats.temp.count > 0 ? state.stats.temp.sum / state.stats.temp.count : null;
  let displayPowerAvg = powerAvg;
  let displayTempAvg = tempAvg;

  if (state.settings.statsRange && state.chartData.timestamps.length > 0) {
    const { startIndex, endIndex } = getVisibleDataRange();

    let minV = Infinity,
      maxV = -Infinity;
    let minC = Infinity,
      maxC = -Infinity;
    let minP = Infinity,
      maxP = -Infinity;
    let minT = Infinity,
      maxT = -Infinity;
    let sumP = 0,
      countP = 0;
    let sumT = 0,
      countT = 0;

    for (let i = startIndex; i <= endIndex; i++) {
      const v = state.chartData.voltage[i];
      const c = state.chartData.current[i];
      const p = state.chartData.power[i];
      const t = state.chartData.temp[i];

      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
      sumP += p;
      countP += 1;
      if (Number.isFinite(t) && t < minT) minT = t;
      if (Number.isFinite(t) && t > maxT) maxT = t;
      if (Number.isFinite(t)) {
        sumT += t;
        countT += 1;
      }
    }

    displayStats = {
      voltage: { min: minV, max: maxV, sum: 0, count: 0 },
      current: { min: minC, max: maxC, sum: 0, count: 0 },
      power: { min: minP, max: maxP, sum: 0, count: 0 },
      temp: { min: minT, max: maxT, sum: 0, count: 0 },
    };

    powerAvg = countP > 0 ? sumP / countP : null;
    tempAvg = countT > 0 ? sumT / countT : null;
    displayPowerAvg = powerAvg;
    displayTempAvg = tempAvg;
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

/** 更新能量显示。 */
export function updateEnergyDisplay() {
  const whEl = document.getElementById('rt-energy');
  const mahEl = document.getElementById('rt-capacity');
  if (whEl) whEl.textContent = state.energy.wh.toFixed(4);
  if (mahEl) mahEl.textContent = state.energy.mah.toFixed(2);
}

// ─── Throttled stats refresh ─────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let __statsUpdateTimer = null;

/**
 * 节流版 updateStatsDisplay。
 * 范围统计需要 O(可见点数) 的遍历，流式采样不需要每个点都同步重扫。
 * 250ms 的上限刷新间隔保持 UI 可读性，同时避免长录制时主线程被统计占满。
 */
export function scheduleStatsUpdate() {
  if (__statsUpdateTimer !== null) return;
  __statsUpdateTimer = setTimeout(() => {
    __statsUpdateTimer = null;
    updateStatsDisplay();
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
  state.energy = { wh: 0, mah: 0, lastTimestamp: null };
  updateEnergyDisplay();
}

/** 清空图表数据和相关状态。 */
export function clearChart() {
  if (state.isRecording) stopRecording();
  state.chartData = { timestamps: [], voltage: [], current: [], power: [], temp: [] };
  state.chartSeries = { x: [], voltage: [], current: [], power: [], temp: [] };
  state.lastRecordingStartTime = null;
  state.recordingBaseSeconds = 0;

  if (!state.isTempConnected) {
    state.hasTempData = false;
    updateTempUIVisibility();
  }

  setChartXWindow(null, null);
  syncChartSeries();
  updateCharts();

  const el = document.getElementById('data-count');
  if (el) el.textContent = '0';
}

// ─── Recording control ───────────────────────────────────────────────────────

/** 开始录制。 */
export function startRecording() {
  if (!state.isConnected) {
    console.warn('Attempted to start recording while not connected');
    return;
  }
  if (state.isRecording) return;

  state.isRecording = true;
  const now = Date.now();
  state.recordingStartTime = now;
  if (state.chartData.timestamps.length === 0) {
    state.lastRecordingStartTime = now;
    state.recordingBaseSeconds = 0;
  } else {
    const lastX = state.chartSeries.x[state.chartSeries.x.length - 1];
    state.recordingBaseSeconds =
      (Number.isFinite(lastX) ? lastX : 0) + Math.max(state.settings.sampleRate / 1000, 0.001);
    if (state.lastRecordingStartTime === null) state.lastRecordingStartTime = state.chartData.timestamps[0];
  }
  // 暂停期间不属于下一段能量积分区间。
  state.energy.lastTimestamp = null;
  state.autoPauseSettings.triggerStartTime = null;

  const el = document.getElementById('record-status');
  if (el) el.textContent = '记录中...';

  const btnStart = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-start-record'));
  const btnStop = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-stop-record'));
  const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
  if (btnStart) btnStart.disabled = true;
  if (btnStop) btnStop.disabled = false;
  if (btnClear) btnClear.disabled = true;

  if (typeof state.__setRangeControlsEnabled === 'function') {
    state.__setRangeControlsEnabled(false);
  }
}

/** 停止录制。 */
export function stopRecording() {
  if (!state.isRecording) return;

  state.isRecording = false;
  state.recordingStartTime = null;
  state.energy.lastTimestamp = null;
  state.autoPauseSettings.triggerStartTime = null;

  const el = document.getElementById('record-status');
  if (el) el.textContent = '停止';

  const btnStart = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-start-record'));
  const btnStop = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-stop-record'));
  const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
  if (btnStart) btnStart.disabled = !state.isConnected;
  if (btnStop) btnStop.disabled = true;
  if (btnClear) btnClear.disabled = false;

  if (typeof state.__setRangeControlsEnabled === 'function') {
    state.__setRangeControlsEnabled(true);
  }
}

/** 清空图表并重置统计和能量。 */
export function clearAndResetStats() {
  clearChart();
  resetStats();
  resetEnergy();
}
