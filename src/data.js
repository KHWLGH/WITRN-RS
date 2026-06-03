// @ts-check
/**
 * @file 数据入库、统计计算、UI 显示更新、录制控制、图表/统计重置。
 */

import { scheduleChartUpdate } from './chart.js';
import { DOWNSAMPLE_CONFIG, state } from './state.js';
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
  const tempValue = state.currentTemp !== null ? state.currentTemp : 0;

  // 仅录制模式：未录制时只更新实时显示
  if (state.collectWhenRecordingOnly && !state.isRecording) {
    updateRealtimeDisplay({ ...data, current: currentAbs, power: powerAbs, temp: tempValue });
    const el = document.getElementById('data-count');
    if (el) el.textContent = String(state.chartData.timestamps.length);
    return;
  }

  const nowMs = now.getTime();
  const baselineMs = state.chartData.timestamps.length ? state.chartData.timestamps[0] : nowMs;
  const relSeconds = (nowMs - baselineMs) / 1000;

  // 全精度原始数据
  state.chartData.timestamps.push(nowMs);
  state.chartData.voltage.push(data.voltage);
  state.chartData.current.push(currentAbs);
  state.chartData.power.push(powerAbs);
  state.chartData.temp.push(tempValue);

  // x/y 序列
  state.chartSeries.voltage.push({ x: relSeconds, y: data.voltage });
  state.chartSeries.current.push({ x: relSeconds, y: currentAbs });
  state.chartSeries.power.push({ x: relSeconds, y: powerAbs });
  state.chartSeries.temp.push({ x: relSeconds, y: tempValue });

  updateChartRange();

  updateStats('voltage', data.voltage);
  updateStats('current', currentAbs);
  updateStats('power', powerAbs);
  if (state.isTempConnected && tempValue !== 0 && state.isRecording) {
    updateStats('temp', tempValue);
  }

  // 能量累计
  if (state.energy.lastTimestamp !== null) {
    const dt = (now.getTime() - state.energy.lastTimestamp) / 3600000;
    state.energy.wh += powerAbs * dt;
    state.energy.mah += currentAbs * 1000 * dt;
  }
  state.energy.lastTimestamp = now.getTime();

  updateRealtimeDisplay({ ...data, current: currentAbs, power: powerAbs, temp: tempValue });
  updateStatsDisplay();
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
          console.info('Auto paused due to trigger condition');
        }
      }
    } else {
      state.autoPauseSettings.triggerStartTime = null;
    }
  }

  // 录制数据
  const recordStatusEl = document.getElementById('record-status');
  if (state.isRecording && recordStatusEl && recordStatusEl.textContent === '记录中...') {
    const relSec = state.recordingStartTime ? (now.getTime() - state.recordingStartTime) / 1000 : 0;
    const rel = formatRelativeHMS(relSec);
    state.recordedData.push({
      timestamp: rel,
      voltage: data.voltage,
      current: currentAbs,
      power: powerAbs,
      temp: tempValue,
      relSeconds: relSec,
    });
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
  if (handleStart) handleStart.style.left = `${start}%`;
  if (handleEnd) handleEnd.style.left = `${end}%`;
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

  let startIndex = Math.floor((totalPoints * state.settings.rangeStart) / 1000);
  let endIndex = Math.floor((totalPoints * state.settings.rangeEnd) / 1000);

  if (startIndex < 0) startIndex = 0;
  if (endIndex >= totalPoints) endIndex = totalPoints - 1;
  if (startIndex > endIndex) startIndex = endIndex;

  const baselineMs = state.chartData.timestamps[0];
  const startSeconds = baselineMs ? (state.chartData.timestamps[startIndex] - baselineMs) / 1000 : 0;
  let endSeconds = baselineMs ? (state.chartData.timestamps[endIndex] - baselineMs) / 1000 : 0;

  // 拖到尾部时使用渲染序列末尾坐标
  const tailSeries = state.renderSeries.voltage?.length ? state.renderSeries.voltage : state.chartSeries.voltage;
  if (endIndex === totalPoints - 1 && tailSeries.length) {
    const lastX = tailSeries[tailSeries.length - 1]?.x;
    if (typeof lastX === 'number' && Number.isFinite(lastX)) {
      endSeconds = lastX;
    }
  }

  const rangeSeconds = Math.max(0, endSeconds - startSeconds);
  const padSeconds = Math.max(rangeSeconds * 0.005, 0.05);
  const paddedStart = Math.max(0, startSeconds - padSeconds);
  const paddedEnd = endSeconds + padSeconds;

  if (state.mainChart?.options?.scales?.x) {
    state.mainChart.options.scales.x.min = paddedStart;
    state.mainChart.options.scales.x.max = paddedEnd;
  }

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
  if (state.isTempConnected && data.temp !== undefined) {
    const tEl = document.getElementById('rt-temp');
    if (tEl) tEl.textContent = data.temp.toFixed(1);
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
      if (t !== 0 && t < minT) minT = t;
      if (t !== 0 && t > maxT) maxT = t;
      if (t !== 0) {
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
  state.chartData = { timestamps: [], voltage: [], current: [], power: [], temp: [] };
  state.chartSeries = { voltage: [], current: [], power: [], temp: [] };
  state.renderSeries = { voltage: [], current: [], power: [], temp: [] };
  state.navigatorSeries = { power: [] };
  DOWNSAMPLE_CONFIG.lastRebuildCount = 0;
  DOWNSAMPLE_CONFIG.navLastRebuildCount = 0;
  state.lastRecordingStartTime = null;
  state.recordedData = [];

  if (!state.isTempConnected) {
    state.hasTempData = false;
    updateTempUIVisibility();
  }

  if (state.mainChart) {
    state.mainChart.data.datasets[0].data = state.renderSeries.voltage;
    state.mainChart.data.datasets[1].data = state.renderSeries.current;
    state.mainChart.data.datasets[2].data = state.renderSeries.power;
    state.mainChart.data.datasets[3].data = state.renderSeries.temp;
    state.mainChart.update('none');
  }

  if (state.navigatorChart) {
    state.navigatorChart.data.datasets[0].data = state.navigatorSeries.power;
    state.navigatorChart.update('none');
  }

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
  state.recordingStartTime = Date.now();
  state.lastRecordingStartTime = state.recordingStartTime;
  console.info('Recording started');
  state.recordedData = [];

  const el = document.getElementById('record-status');
  if (el) el.textContent = '记录中...';

  const btnStart = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-start-record'));
  const btnStop = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-stop-record'));
  if (btnStart) btnStart.disabled = true;
  if (btnStop) btnStop.disabled = false;

  if (typeof state.__setRangeControlsEnabled === 'function') {
    state.__setRangeControlsEnabled(false);
  }
}

/** 停止录制。 */
export function stopRecording() {
  if (!state.isRecording) return;

  state.isRecording = false;
  state.recordingStartTime = null;

  const el = document.getElementById('record-status');
  if (el) el.textContent = '停止';

  const btnStart = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-start-record'));
  const btnStop = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-stop-record'));
  if (btnStart) btnStart.disabled = !state.isConnected;
  if (btnStop) btnStop.disabled = true;

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
