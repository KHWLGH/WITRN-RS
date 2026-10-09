// @ts-check
/**
 * @file 数据入库、统计计算、UI 显示更新、录制控制、图表/统计重置。
 */

import { scheduleChartUpdate as requestChartUpdate, setChartXWindow, syncChartSeries, updateCharts } from './chart.js';
import { firstIndexAfter, firstIndexAtOrAfter } from './chart-buckets.js';
import {
  classifyChartWindow,
  emptyChartWindow,
  minZoomSpan,
  resolveChartWindow,
  zoomTimeWindow,
} from './chart-window.js';
import { deviceStream } from './device-stream.js';
import { displayFrames } from './frame-scheduler.js';
import { energyMaxStepS, nextRecordingX, niceCeiling, streamSampleTime } from './measurement.js';
import { performanceDiagnostics } from './performance-diagnostics.js';
import { captureRangeStatsSnapshot, computeRangeStatsSync, rangeStatsRevision } from './range-stats.js';
import { computeRangeStatsBackground } from './range-stats-background.js';

deviceStream.configure({
  getColumns: () => state.chartSeries,
  onSample: (sample, segment) => addDataPoint(sample, segment),
  onBatchStart: () => beginIngestBatch(),
  onBatchEnd: () => endIngestBatch(),
  onBatch: () => spoolRowsAppended(),
});

import { t } from './i18n.js';
import { describeLimit, formatPoints, pointsForLimit, remainingInfo, WARN_FRACTION } from './recording-limit.js';
import {
  configureSpool,
  finalizeSpool,
  spoolRecordingPaused,
  spoolRecordingStarted,
  spoolRowsAppended,
} from './recording-spool.js';
import { emptyChartColumns, setChartColumns, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { syncRecordUI } from './ui/controlbar.js';
import { toast } from './ui/toast.js';
import { formatRelativeHMS, formatSampleRateLabel } from './utils.js';

configureSpool({
  onFailure: () => {
    void stopRecording().catch(() => {});
  },
});

const RECORD_COLUMNS = /** @type {(keyof import('./state.js').ChartSeriesColumns)[]} */ ([
  'x',
  'timestamps',
  'voltage',
  'current',
  'power',
  'temp',
  'dp',
  'dn',
  'cc1',
  'cc2',
  'recordingSegments',
  'sampleIntervals',
]);

/** @param {string} cmd @param {Record<string, unknown>} [args] */
function invokeCmd(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return Promise.resolve(null);
  return invoke(cmd, args);
}

/** @type {Record<string, number>} */
const meterPeak = {
  voltage: 0,
  current: 0,
  power: 0,
  temp: 0,
  energy: 0,
  capacity: 0,
  dp: 0,
  dn: 0,
  cc1: 0,
  cc2: 0,
};

/** 监控视图隐藏期间只积累数据，恢复时从最新状态一次性补齐显示。 */
function monitorDisplayVisible() {
  return state.settings.activeView === 'monitor' && state.windowVisible && !document.hidden;
}

/** @param {Element|null} el @param {string} value */
function setTextIfChanged(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

/** @param {HTMLElement|null} el @param {string} value */
function setTransformIfChanged(el, value) {
  if (el?.style && el.style.transform !== value) el.style.transform = value;
}

/** @param {keyof typeof meterPeak} channel @param {number} value */
function trackMeterPeak(channel, value) {
  const abs = Math.abs(value);
  if (Number.isFinite(abs) && abs > meterPeak[channel]) meterPeak[channel] = abs;
}

/**
 * @param {string} id
 * @param {keyof typeof meterPeak} channel
 * @param {number} value
 * @param {'x'|'y'} axis
 */
function setMeter(id, channel, value, axis) {
  const el = document.getElementById(id);
  if (!el?.style) return;
  const abs = Math.abs(value);
  if (!Number.isFinite(abs)) {
    setTransformIfChanged(el, axis === 'x' ? 'scaleX(0)' : 'scaleY(0)');
    return;
  }
  trackMeterPeak(channel, value);
  const ceil = niceCeiling(meterPeak[channel]);
  const pct = ceil > 0 ? Math.min(1, abs / ceil) : 0;
  setTransformIfChanged(el, axis === 'x' ? `scaleX(${pct})` : `scaleY(${pct})`);
}

function resetMeters() {
  for (const key of Object.keys(meterPeak)) meterPeak[key] = 0;
  for (const id of [
    'lv-voltage',
    'lv-current',
    'lv-power',
    'lv-temp',
    'lv-energy',
    'lv-capacity',
    'lv-dp',
    'lv-dn',
    'lv-cc1',
    'lv-cc2',
  ]) {
    const el = document.getElementById(id);
    setTransformIfChanged(el, 'scaleX(0)');
  }
}

export function updateChartEmptyState() {
  if (!monitorDisplayVisible()) return;
  document.querySelector?.('.chart-container')?.classList.toggle('has-data', state.chartSeries.x.length > 0);
}

/** @type {ReturnType<typeof setInterval>|null} */
let durationTimer = null;

export function updateDurationDisplay() {
  const el = document.getElementById('record-duration');
  if (!el) return;
  const lastX = state.chartSeries.x.length > 0 ? state.chartSeries.x.at(-1) : Number.NaN;
  let seconds = Number.isFinite(lastX) ? lastX : 0;
  if (state.isRecording && state.recordingStartTime !== null) {
    seconds = state.recordingBaseSeconds + Math.max(0, (Date.now() - state.recordingStartTime) / 1000);
  }
  setTextIfChanged(el, state.chartSeries.x.length === 0 && !state.isRecording ? '--' : formatRelativeHMS(seconds));
}

export function updateSampleRateStatus() {
  const el = document.getElementById('status-sample-rate');
  const intervalMs = state.settings.sampleRate;
  const perSecond = Number((1000 / intervalMs).toFixed(2));
  const value =
    intervalMs > 1000
      ? t('secondsPerSample', { value: perSecond, seconds: Number((intervalMs / 1000).toFixed(2)) })
      : t('samplesPerSecond', { value: perSecond });
  setTextIfChanged(el, value || formatSampleRateLabel(intervalMs));
  refreshRecordLimitUI();
}

// ─── Single-recording limit ──────────────────────────────────────────────────

/** 已为哪份数据提示过「接近上限」/「已达上限」：每份数据各提示一次。 */
/** @type {object|null} */
let limitWarnedFor = null;
/** @type {object|null} */
let limitReachedFor = null;

function recordLimitPoints() {
  return pointsForLimit(state.settings.recordLimitMb);
}

/** 底栏剩余提示：按当前采样率估算还能记录多久。 */
export function updateRemainingDisplay() {
  const el = document.getElementById('record-remaining');
  if (!el) return;
  const info = remainingInfo(state.chartSeries.x.length, recordLimitPoints(), state.settings.sampleRate);
  setTextIfChanged(el, info.text);
  const item = document.getElementById('status-remaining');
  if (item) {
    item.classList?.toggle?.('is-warning', info.warn);
    if (item.title !== info.title) item.title = info.title;
  }
}

/** 设置页上限说明与底栏同步刷新（上限或采样率变了）。 */
export function refreshRecordLimitUI() {
  setTextIfChanged(
    document.getElementById('record-limit-hint'),
    describeLimit(state.settings.recordLimitMb, state.settings.sampleRate),
  );
  updateRemainingDisplay();
}

/**
 * 还能再记录一个点吗。到 90% 提示一次；到上限时自动暂停一次并说明原因。
 * @param {import('./state.js').ChartSeriesColumns} cols
 */
function admitRecordedPoint(cols) {
  const limit = recordLimitPoints();
  const used = cols.x.length;
  if (used < limit) {
    if (used >= limit * WARN_FRACTION && limitWarnedFor !== cols) {
      limitWarnedFor = cols;
      toast.warning(() => t('limitWarning', { used: formatPoints(used), limit: formatPoints(limit) }));
    }
    return true;
  }
  if (limitReachedFor !== cols) {
    limitReachedFor = cols;
    void stopRecording().catch(() => {});
    toast.warning(() => t('limitReached', { limit: formatPoints(limit) }), {
      duration: 0,
    });
  }
  return false;
}

function startDurationTicker() {
  if (durationTimer !== null) return;
  updateDurationDisplay();
  durationTimer = setInterval(updateDurationDisplay, 250);
}

function stopDurationTicker() {
  if (durationTimer !== null) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
  updateDurationDisplay();
}

/** 按当前状态刷新命令栏的记录按钮（开始 / 继续 / 暂停）。 */
export function refreshRecordButton() {
  syncRecordUI({
    connected: state.isConnected,
    recording: state.isRecording,
    hasData: state.chartSeries.timestamps.length > 0,
    followPd: state.settings.pdFollowRecording,
  });
}

// ─── Data ingestion ──────────────────────────────────────────────────────────

/**
 * 接收一条设备数据，更新存储、统计、图表。
 * @param {import('./state.js').DeviceData | import('./device-stream.js').StreamSample} data
 * @param {import('./device-stream.js').RecordingSegment|null} [segment] Native null means preview only.
 */
export function addDataPoint(data, segment) {
  const native = 'received_us' in data;
  const time = native ? streamSampleTime(data, segment?.baseSeconds ?? 0) : null;
  const nowMs = time?.wallMs ?? Date.now();
  const record = native ? !!segment : state.isRecording;

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
  trackMeterPeak('voltage', data.voltage);
  trackMeterPeak('current', currentValue);
  trackMeterPeak('power', powerAbs);
  trackMeterPeak('temp', tempValue);
  for (const channel of /** @type {const} */ (['dp', 'dn', 'cc1', 'cc2'])) {
    trackMeterPeak(channel, /** @type {number} */ (data[channel]));
  }

  // Live preview coalesces too; native segment gating is independent of arrival-time UI state.
  if (!record) {
    scheduleRangeUi();
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
  if (!admitRecordedPoint(cols)) {
    scheduleRangeUi();
    return;
  }
  const activeElapsed = state.recordingStartTime === null ? 0 : (nowMs - state.recordingStartTime) / 1000;
  const prevX = cols.x.length > 0 ? cols.x.at(-1) : Number.NaN;
  const relSeconds = time
    ? time.seconds
    : nextRecordingX(prevX, state.recordingBaseSeconds + Math.max(0, activeElapsed), state.settings.sampleRate);
  const beginsSegment = segment ? segment.first : state.energy.lastX === null;
  const sampleInterval =
    native && Number.isFinite(data.rate_ms) && data.rate_ms > 0 ? data.rate_ms : state.settings.sampleRate;
  if (cols.x.length === 0) state.dataIntervalMs = sampleInterval;
  const previousSegment = cols.recordingSegments.at(-1);
  for (const key of RECORD_COLUMNS) cols[key].reserveNext();
  cols.recordingSegments.push(
    beginsSegment ? (Number.isFinite(previousSegment) ? previousSegment + 1 : 1) : previousSegment,
  );
  if (segment) segment.first = false;

  cols.timestamps.push(nowMs);
  cols.sampleIntervals.push(sampleInterval);
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
  // 与 integrateEnergy 一致：跳过非有限值，避免单个缺失样本把整条累计污染成 NaN。
  const lastX = segment ? segment.lastX : state.energy.lastX;
  const currentAbs = Math.abs(currentValue);
  if (lastX !== null) {
    const stepS = relSeconds - lastX;
    const dt = stepS / 3600;
    if (
      dt >= 0 &&
      stepS <= energyMaxStepS(sampleInterval) &&
      Number.isFinite(dt) &&
      Number.isFinite(currentAbs) &&
      Number.isFinite(powerAbs)
    ) {
      state.energy.wh += powerAbs * dt;
      state.energy.mah += currentAbs * 1000 * dt;
    }
  }
  if (segment) segment.lastX = relSeconds;
  state.energy.lastX = state.isRecording ? relSeconds : null;
  trackMeterPeak('energy', state.energy.wh);
  trackMeterPeak('capacity', state.energy.mah);

  scheduleStatsUpdate();

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

    const triggerMs = native ? data.received_us / 1000 : nowMs;
    if (value <= state.autoPauseSettings.condition) {
      if (state.autoPauseSettings.duration <= 0) {
        void stopRecording({ discard: true }).catch(() => {});
        state.autoPauseSettings.triggerStartTime = null;
      } else if (state.autoPauseSettings.triggerStartTime === null) {
        state.autoPauseSettings.triggerStartTime = triggerMs;
      } else {
        const elapsed = (triggerMs - state.autoPauseSettings.triggerStartTime) / 1000;
        if (elapsed >= state.autoPauseSettings.duration) {
          void stopRecording({ discard: true }).catch(() => {});
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
  if (!monitorDisplayVisible()) return;
  const startEl = /** @type {HTMLInputElement|null} */ (document.getElementById('range-start'));
  const endEl = /** @type {HTMLInputElement|null} */ (document.getElementById('range-end'));
  if (startEl && startEl.value !== String(state.settings.rangeStart)) startEl.value = String(state.settings.rangeStart);
  if (endEl && endEl.value !== String(state.settings.rangeEnd)) endEl.value = String(state.settings.rangeEnd);

  const start = state.settings.rangeStart / 10;
  const end = state.settings.rangeEnd / 10;
  const fill = document.getElementById('slider-fill');
  if (fill?.style) {
    if (fill.style.left !== `${start}%`) fill.style.left = `${start}%`;
    if (fill.style.width !== `${end - start}%`) fill.style.width = `${end - start}%`;
  }
  fill?.classList?.toggle('is-pannable', state.settings.rangeEnd - state.settings.rangeStart < 1000);

  const handleStart = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-start'));
  const handleEnd = /** @type {HTMLElement|null} */ (document.getElementById('range-handle-end'));
  if (handleStart?.style) {
    if (handleStart.style.left !== `${start}%`) handleStart.style.left = `${start}%`;
    if (handleStart.getAttribute?.('aria-valuenow') !== String(start))
      handleStart.setAttribute('aria-valuenow', String(start));
  }
  if (handleEnd?.style) {
    if (handleEnd.style.left !== `${end}%`) handleEnd.style.left = `${end}%`;
    if (handleEnd.getAttribute?.('aria-valuenow') !== String(end)) handleEnd.setAttribute('aria-valuenow', String(end));
  }
}

function sampleEdgeEps() {
  return Math.max(state.settings.sampleRate / 1000, 0.001);
}

/** @param {number} start @param {number} end */
function writePermille(start, end) {
  const s = Math.max(0, Math.min(1000, start | 0));
  const e = Math.max(s, Math.min(1000, end | 0));
  state.settings.rangeStart = s;
  state.settings.rangeEnd = e;
}

/**
 * 把已判定的时间窗反推成滑块千分比（follow 右柄钉在 1000）。
 * @param {{ mode: string, min: number, max: number }} win
 * @param {number} n
 * @param {import('./state.js').F64Col} xs
 */
function writePermilleFromWindow(win, n, xs) {
  if (win.mode === 'full' || n <= 1) {
    writePermille(0, 1000);
    return;
  }
  const startIndex = firstIndexAtOrAfter(xs, n, win.min);
  const startP = Math.max(0, Math.min(1000, Math.round((startIndex * 1000) / n)));
  if (win.mode === 'follow') {
    writePermille(startP, 1000);
    return;
  }
  const endIndex = Math.max(startIndex, firstIndexAfter(xs, n, win.max) - 1);
  const endP = Math.max(startP, Math.min(1000, Math.round(((endIndex + 1) * 1000) / n)));
  writePermille(startP, endP);
}

function permilleIndices(totalPoints) {
  let startIndex = Math.floor((totalPoints * state.settings.rangeStart) / 1000);
  let endIndex = Math.floor((totalPoints * state.settings.rangeEnd) / 1000);
  if (endIndex >= totalPoints) endIndex = totalPoints - 1;
  if (startIndex > endIndex) startIndex = endIndex;
  if (startIndex < 0) startIndex = 0;
  return { startIndex, endIndex };
}

/** 滑块改了千分比之后，把当前选区收成时间窗会话态。 */
export function adoptWindowFromPermille() {
  const xs = state.chartSeries.x;
  const n = xs.length;
  if (n === 0) {
    state.chartWindow = emptyChartWindow();
    return;
  }
  const { startIndex, endIndex } = permilleIndices(n);
  const min = xs.valueAt(startIndex);
  const max = xs.valueAt(endIndex);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    state.chartWindow = emptyChartWindow();
    return;
  }
  state.chartWindow = classifyChartWindow(min, max, xs.at(0), xs.at(-1), sampleEdgeEps());
}

/**
 * 滚轮横向缩放：绕 pivot 缩放当前时间窗，写回滑块与 xWindow。
 * @param {number} pivotSec
 * @param {number} factor
 */
export function applyChartXZoom(pivotSec, factor) {
  const xs = state.chartSeries.x;
  const n = xs.length;
  if (n === 0) return;
  const dataMin = xs.at(0);
  const dataMax = xs.at(-1);
  const current = resolveChartWindow(state.chartWindow, dataMin, dataMax);
  const zoomed = zoomTimeWindow({
    min: current.min,
    max: current.max,
    pivot: pivotSec,
    factor,
    dataMin,
    dataMax,
    minSpan: minZoomSpan(state.settings.sampleRate),
  });
  state.chartWindow = classifyChartWindow(zoomed.min, zoomed.max, dataMin, dataMax, sampleEdgeEps());
  paintFromWindow(xs, n, dataMin, dataMax);
  if (monitorDisplayVisible()) {
    updateSliderFill();
    writeRangeLabels(xs);
  }
  requestChartUpdate('interaction');
  if (state.settings.statsRange) scheduleStatsUpdate();
}

state.__applyChartXZoom = applyChartXZoom;

function paintEmptyRangeLabels() {
  const el1 = document.getElementById('range-start-time');
  const el2 = document.getElementById('range-end-time');
  const el3 = document.getElementById('range-duration');
  setTextIfChanged(el1, '--');
  setTextIfChanged(el2, '--');
  setTextIfChanged(el3, t('noDataRange'));
}

/**
 * @param {import('./state.js').ChartSeriesColumns['x']} xs
 * @param {number} n
 * @param {number} dataMin
 * @param {number} dataMax
 */
function paintFromWindow(xs, n, dataMin, dataMax) {
  const resolved = resolveChartWindow(state.chartWindow, dataMin, dataMax);
  state.chartWindow = resolved;
  setChartXWindow(resolved.min, resolved.max);
  writePermilleFromWindow(resolved, n, xs);
}

/**
 * @param {import('./state.js').ChartSeriesColumns['x']} xs
 * @param {number} n
 * @param {number} dataMin
 * @param {number} dataMax
 */
function paintFromPermille(xs, n, dataMin, dataMax) {
  const { startIndex, endIndex } = permilleIndices(n);
  const startSeconds = Number.isFinite(xs.valueAt(startIndex)) ? xs.valueAt(startIndex) : dataMin;
  const endSeconds = Number.isFinite(xs.valueAt(endIndex)) ? xs.valueAt(endIndex) : dataMax;
  setChartXWindow(startSeconds, endSeconds);
  state.chartWindow = classifyChartWindow(startSeconds, endSeconds, dataMin, dataMax, sampleEdgeEps());
  if (state.chartWindow.mode !== 'full') {
    writePermilleFromWindow(state.chartWindow, n, xs);
  }
}

/** @param {import('./state.js').ChartSeriesColumns['x']} xs */
function writeRangeLabels(xs) {
  const { startIndex, endIndex } = getVisibleDataRange();
  const startSeconds = Number.isFinite(xs.valueAt(startIndex)) ? xs.valueAt(startIndex) : 0;
  const endSeconds = Number.isFinite(xs.valueAt(endIndex)) ? xs.valueAt(endIndex) : 0;

  const el1 = document.getElementById('range-start-time');
  const el2 = document.getElementById('range-end-time');
  setTextIfChanged(el1, formatRelativeHMS(startSeconds));
  setTextIfChanged(el2, formatRelativeHMS(endSeconds));

  const points = endIndex - startIndex + 1;
  const durationSec = Math.max(0, endSeconds - startSeconds);
  const el3 = document.getElementById('range-duration');
  setTextIfChanged(el3, t('durationPoints', { duration: formatRelativeHMS(durationSec), points }));
  if (state.settings.statsRange) markStaleRangeStatsPending();
}

/** 根据滑块值 / 时间窗更新主图表的可见范围。 */
export function updateChartRange() {
  const xs = state.chartSeries.x;
  const n = xs.length;
  if (n === 0) {
    setChartXWindow(null, null);
    if (monitorDisplayVisible()) {
      updateSliderFill();
      paintEmptyRangeLabels();
    }
    return;
  }

  const dataMin = xs.at(0);
  const dataMax = xs.at(-1);
  const mode = state.chartWindow?.mode ?? 'full';
  if (!state.__rangeDragging && (mode === 'follow' || mode === 'frozen')) {
    paintFromWindow(xs, n, dataMin, dataMax);
  } else {
    paintFromPermille(xs, n, dataMin, dataMax);
  }
  if (monitorDisplayVisible()) {
    updateSliderFill();
    writeRangeLabels(xs);
  }
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
  lastRealtime = data;
  if (!monitorDisplayVisible()) return;
  const vEl = document.getElementById('rt-voltage');
  const cEl = document.getElementById('rt-current');
  const pEl = document.getElementById('rt-power');
  setTextIfChanged(vEl, data.voltage.toFixed(4));
  // 电流数值恒显示幅值，方向由箭头表达（需求：不用正负号）
  setTextIfChanged(cEl, Math.abs(data.current).toFixed(4));
  setTextIfChanged(pEl, data.power.toFixed(4));

  setMeter('lv-voltage', 'voltage', data.voltage, 'x');
  setMeter('lv-current', 'current', data.current, 'x');
  setMeter('lv-power', 'power', data.power, 'x');

  const dirEl = /** @type {HTMLElement|null} */ (document.getElementById('rt-current-dir'));
  if (dirEl) {
    const showDir = state.settings.signedCurrent && Number.isFinite(data.current) && data.current !== 0;
    if (dirEl.hidden !== !showDir) dirEl.hidden = !showDir;
    if (showDir) {
      dirEl.classList?.toggle('fi-arrow-right', data.current > 0);
      dirEl.classList?.toggle('fi-arrow-left', data.current < 0);
      const title = data.current > 0 ? t('forwardCurrent') : t('reverseCurrent');
      if (dirEl.title !== title) dirEl.title = title;
    }
  }

  if (state.isTempConnected && Number.isFinite(data.temp)) {
    const tEl = document.getElementById('rt-temp');
    setTextIfChanged(tEl, data.temp.toFixed(1));
    setMeter('lv-temp', 'temp', data.temp, 'x');
  } else if (state.isTempConnected) {
    const tEl = document.getElementById('rt-temp');
    setTextIfChanged(tEl, '--');
    setMeter('lv-temp', 'temp', Number.NaN, 'x');
  }

  /** @param {string} id @param {number|undefined} val */
  const setSignal = (id, val) => {
    const el = document.getElementById(id);
    setTextIfChanged(el, Number.isFinite(val) ? /** @type {number} */ (val).toFixed(2) : '--');
  };
  setSignal('rt-dp', data.dp);
  setSignal('rt-dn', data.dn);
  setSignal('rt-cc1', data.cc1);
  setSignal('rt-cc2', data.cc2);
  setMeter('lv-dp', 'dp', Number.isFinite(data.dp) ? /** @type {number} */ (data.dp) : Number.NaN, 'x');
  setMeter('lv-dn', 'dn', Number.isFinite(data.dn) ? /** @type {number} */ (data.dn) : Number.NaN, 'x');
  setMeter('lv-cc1', 'cc1', Number.isFinite(data.cc1) ? /** @type {number} */ (data.cc1) : Number.NaN, 'x');
  setMeter('lv-cc2', 'cc2', Number.isFinite(data.cc2) ? /** @type {number} */ (data.cc2) : Number.NaN, 'x');
}

/**
 * 获取当前可见数据范围的索引。
 * @returns {{ startIndex: number, endIndex: number }}
 */
export function getVisibleDataRange() {
  const totalPoints = state.chartSeries.timestamps.length;
  if (totalPoints === 0) return { startIndex: 0, endIndex: 0 };

  const mode = state.chartWindow?.mode ?? 'full';
  if (mode === 'follow' || mode === 'frozen') {
    const xs = state.chartSeries.x;
    const min = state.chartWindow.min;
    const max = state.chartWindow.max;
    let startIndex = firstIndexAtOrAfter(xs, totalPoints, min);
    let endIndex = firstIndexAfter(xs, totalPoints, max) - 1;
    if (endIndex >= totalPoints) endIndex = totalPoints - 1;
    if (endIndex < 0) endIndex = 0;
    if (startIndex > endIndex) startIndex = endIndex;
    if (startIndex < 0) startIndex = 0;
    return { startIndex, endIndex };
  }

  return permilleIndices(totalPoints);
}

/** @type {import('./range-stats.js').RangeStats|null} */
let rangeStatsCache = null;
/** @typedef {import('./range-stats.js').RangeStatsSnapshot} RangeSnapshot */
/**
 * @typedef {{ snapshot: RangeSnapshot, windowKey: string, cancelled: boolean,
 *   controller: AbortController, promise: Promise<import('./range-stats.js').RangeStats|null> }} RangeStatsJob
 */
/** @type {RangeStatsJob|null} */
let rangeStatsJob = null;
const SYNC_RANGE_POINTS = 4096;
let rangeCalculationMs = 0;
let rangeStartedAt = -Infinity;
let rangeStartedWindow = '';
/** @type {import('./state.js').ChartSeriesColumns|null} */
let rangeStartedColumns = null;
let rangeStartedRevision = -1;
/** @type {ReturnType<typeof setTimeout>|null} */
let rangeRefreshTimer = null;

/** @typedef {Pick<RangeSnapshot,'columns'|'startIndex'|'endIndex'|'len'|'revision'|'maxStepS'>} RangeMetadata */

/** Cheap cache lookup before copying any chunk references. @returns {RangeMetadata|null} */
function currentRangeMetadata() {
  const columns = state.chartSeries;
  if (!columns.x.length) return null;
  return {
    columns,
    ...getVisibleDataRange(),
    len: columns.x.length,
    revision: rangeStatsRevision(columns),
    maxStepS: energyMaxStepS(state.dataIntervalMs),
  };
}

function currentRangeSnapshot() {
  const meta = currentRangeMetadata();
  return meta ? captureRangeStatsSnapshot(meta.columns, meta.startIndex, meta.endIndex, meta.maxStepS) : null;
}

/** @param {RangeMetadata} snapshot */
function matchingRangeCache(snapshot) {
  const cache = rangeStatsCache;
  if (
    cache &&
    cache.columns === snapshot.columns &&
    cache.revision === snapshot.revision &&
    cache.startIndex === snapshot.startIndex &&
    cache.endIndex === snapshot.endIndex &&
    cache.maxStepS === snapshot.maxStepS &&
    snapshot.len >= cache.len
  )
    return cache;
  return null;
}

/** @param {RangeMetadata} snapshot */
function incrementalRangeOptions(snapshot) {
  const cache = rangeStatsCache;
  if (
    cache &&
    cache.columns === snapshot.columns &&
    cache.revision === snapshot.revision &&
    cache.startIndex === 0 &&
    snapshot.startIndex === 0 &&
    cache.endIndex === cache.len - 1 &&
    snapshot.endIndex === snapshot.len - 1 &&
    cache.maxStepS === snapshot.maxStepS &&
    snapshot.len > cache.len
  )
    return { seed: cache, foldStart: cache.len };
  return { foldStart: snapshot.startIndex };
}

/** 范围同步查询保留给显式调用；UI 使用下面的分片路径。 */
export function getRangeStats() {
  const snapshot = currentRangeSnapshot();
  if (!snapshot) return null;
  const cached = matchingRangeCache(snapshot);
  if (cached) return cached;
  rangeStatsCache = computeRangeStatsSync(snapshot, incrementalRangeOptions(snapshot));
  return rangeStatsCache;
}

function rangeWindowKey() {
  const window = state.chartWindow;
  // Follow advances with incoming samples; a changed duration is a new user window.
  if (window.mode === 'follow') return `follow:${window.duration}`;
  if (window.mode === 'frozen') return `frozen:${window.min}:${window.max}`;
  return `full:${state.settings.rangeStart}:${state.settings.rangeEnd}`;
}

function cancelRangeStatsJob() {
  if (rangeStatsJob) {
    rangeStatsJob.cancelled = true;
    rangeStatsJob.controller.abort();
  }
  rangeStatsJob = null;
  if (rangeRefreshTimer !== null) clearTimeout(rangeRefreshTimer);
  rangeRefreshTimer = null;
}

export function suspendMonitorDisplay() {
  cancelRangeStatsJob();
  if (__statsUpdateTimer !== null) clearTimeout(__statsUpdateTimer);
  __statsUpdateTimer = null;
}

/** @param {number} delay */
function scheduleRangeCalculation(delay) {
  if (rangeRefreshTimer !== null) return;
  rangeRefreshTimer = setTimeout(
    () => {
      rangeRefreshTimer = null;
      updateStatsDisplay();
      updateEnergyDisplay();
    },
    Math.max(0, delay),
  );
}

/** @param {RangeStatsJob} job */
function rangeStatsJobInvalid(job) {
  const snapshot = job.snapshot;
  if (
    job.cancelled ||
    !monitorDisplayVisible() ||
    !state.settings.statsRange ||
    state.chartSeries !== snapshot.columns ||
    state.chartSeries.x.length < snapshot.len ||
    rangeStatsRevision(state.chartSeries) !== snapshot.revision ||
    energyMaxStepS(state.dataIntervalMs) !== snapshot.maxStepS ||
    rangeWindowKey() !== job.windowKey
  )
    return true;
  const range = getVisibleDataRange();
  if (range.startIndex === snapshot.startIndex && range.endIndex === snapshot.endIndex) return false;
  // Natural append may move a full/follow window while its fixed snapshot finishes.
  return !(
    state.chartSeries.x.length > snapshot.len &&
    (state.chartWindow.mode === 'follow' || (snapshot.startIndex === 0 && snapshot.endIndex === snapshot.len - 1)) &&
    range.startIndex >= snapshot.startIndex &&
    range.endIndex >= snapshot.endIndex
  );
}

/**
 * Resolve a fixed current-window snapshot; cancellation resolves to null.
 * Large ranges run in a Worker (cooperative fallback); short append tails remain synchronous.
 * @returns {Promise<import('./range-stats.js').RangeStats|null>}
 */
export function getRangeStatsAsync() {
  const meta = currentRangeMetadata();
  if (!meta || !state.settings.statsRange || !monitorDisplayVisible()) {
    cancelRangeStatsJob();
    return Promise.resolve(null);
  }
  const cached = matchingRangeCache(meta);
  if (cached) return Promise.resolve(cached);
  if (rangeStatsJob && rangeStatsJobInvalid(rangeStatsJob)) cancelRangeStatsJob();
  if (rangeStatsJob) return rangeStatsJob.promise;
  const options = incrementalRangeOptions(meta);
  const windowKey = rangeWindowKey();
  const delay = rangeStartedAt + Math.max(250, rangeCalculationMs * 4) - performance.now();
  if (
    meta.endIndex - options.foldStart + 1 > SYNC_RANGE_POINTS &&
    delay > 0 &&
    rangeStartedWindow === windowKey &&
    rangeStartedColumns === meta.columns &&
    rangeStartedRevision === meta.revision
  ) {
    scheduleRangeCalculation(delay);
    return Promise.resolve(completedRangeSnapshot(meta));
  }
  const snapshot = captureRangeStatsSnapshot(meta.columns, meta.startIndex, meta.endIndex, meta.maxStepS);
  if (snapshot.endIndex - options.foldStart + 1 <= SYNC_RANGE_POINTS) {
    rangeStatsCache = computeRangeStatsSync(snapshot, options);
    return Promise.resolve(rangeStatsCache);
  }
  /** @type {RangeStatsJob} */
  const job = {
    snapshot,
    windowKey,
    cancelled: false,
    controller: new AbortController(),
    promise: Promise.resolve(null),
  };
  rangeStatsJob = job;
  rangeStartedAt = performance.now();
  rangeStartedWindow = windowKey;
  rangeStartedColumns = meta.columns;
  rangeStartedRevision = meta.revision;
  job.promise = computeRangeStatsBackground(snapshot, {
    ...options,
    signal: job.controller.signal,
    isCancelled: () => rangeStatsJobInvalid(job),
  }).then((result) => {
    if (rangeStatsJob !== job) return null;
    rangeStatsJob = null;
    if (!result || rangeStatsJobInvalid(job)) return null;
    rangeCalculationMs = performance.now() - rangeStartedAt;
    rangeStatsCache = result;
    // Completed follow snapshots paint with their actual bounds while the latest waits.
    updateStatsDisplay();
    updateEnergyDisplay();
    return result;
  });
  return job.promise;
}

/** Returns null while a large current range is being calculated. */
function getDisplayRangeStats() {
  const snapshot = currentRangeMetadata();
  if (!snapshot) return null;
  const cached = matchingRangeCache(snapshot);
  if (cached) {
    labelRangeSnapshot(cached, false);
    return cached;
  }
  void getRangeStatsAsync();
  const result = matchingRangeCache(snapshot) ?? completedRangeSnapshot(snapshot);
  labelRangeSnapshot(
    result,
    !!result && (result.startIndex !== snapshot.startIndex || result.endIndex !== snapshot.endIndex),
  );
  return result;
}

/** A completed snapshot remains useful when its actual bounds are explicitly labeled.
 * @param {RangeMetadata} snapshot
 */
function completedRangeSnapshot(snapshot) {
  const cache = rangeStatsCache;
  return cache?.columns === snapshot.columns &&
    cache.revision === snapshot.revision &&
    cache.maxStepS === snapshot.maxStepS &&
    cache.len <= snapshot.len
    ? cache
    : null;
}

/** @param {import('./range-stats.js').RangeStats|null} result @param {boolean} updating */
function labelRangeSnapshot(result, updating) {
  const label = document.getElementById('stats-snapshot-label');
  if (!label) return;
  label.hidden = !state.settings.statsRange;
  const xs = result?.columns.x;
  setTextIfChanged(
    label,
    result && xs
      ? t('rangeSnapshot', {
          start: formatRelativeHMS(xs.valueAt(result.startIndex)),
          end: formatRelativeHMS(xs.valueAt(result.endIndex)),
          updating: updating ? t('updating') : '',
        })
      : t('calculatingRange'),
  );
}

/** @param {boolean} pending */
function setRangeStatsPending(pending) {
  if (rangeStatsDisplayPending === pending) return;
  rangeStatsDisplayPending = pending;
  for (const id of [
    'min-voltage',
    'max-voltage',
    'avg-voltage',
    'min-current',
    'max-current',
    'avg-current',
    'min-power',
    'max-power',
    'avg-power',
    'min-temp',
    'max-temp',
    'avg-temp',
    'rt-energy',
    'rt-capacity',
  ]) {
    const el = document.getElementById(id);
    const busy = pending ? 'true' : 'false';
    if (el?.getAttribute?.('aria-busy') !== busy) el?.setAttribute?.('aria-busy', busy);
    if (pending) {
      setTextIfChanged(el, '--');
      if (el && el.title !== '') el.title = '';
    }
  }
  if (pending) {
    setMeter('lv-energy', 'energy', Number.NaN, 'x');
    setMeter('lv-capacity', 'capacity', Number.NaN, 'x');
  }
}

/** @type {boolean|null} */
let rangeStatsDisplayPending = null;

function markStaleRangeStatsPending() {
  if (rangeStatsJob && rangeStatsJobInvalid(rangeStatsJob)) cancelRangeStatsJob();
  const snapshot = currentRangeMetadata();
  if (snapshot && !matchingRangeCache(snapshot) && !completedRangeSnapshot(snapshot)) setRangeStatsPending(true);
}

/** 更新统计显示面板（支持范围模式）。 */
export function updateStatsDisplay() {
  if (!monitorDisplayVisible()) {
    cancelRangeStatsJob();
    return;
  }
  let displayStats = state.stats;
  let powerAvg = state.stats.power.count > 0 ? state.stats.power.sum / state.stats.power.count : null;
  let tempAvg = state.stats.temp.count > 0 ? state.stats.temp.sum / state.stats.temp.count : null;
  let displayPowerAvg = powerAvg;
  let displayTempAvg = tempAvg;
  /** 范围模式下被跳过的非有限样本数，用于在均值上留一条 tooltip 说明。 */
  const skipped = { voltage: 0, current: 0, power: 0, temp: 0 };

  if (state.settings.statsRange && state.chartSeries.x.length > 0) {
    const range = getDisplayRangeStats();
    setRangeStatsPending(!range);
    if (!range) return;
    if (range) {
      const span = range.endIndex - range.startIndex + 1;
      skipped.voltage = span - range.countV;
      skipped.current = span - range.countC;
      skipped.power = span - range.countP;
      skipped.temp = span - range.countT;
      displayStats = {
        voltage: { min: range.minV, max: range.maxV, sum: range.sumV, count: range.countV },
        current: { min: range.minC, max: range.maxC, sum: range.sumC, count: range.countC },
        power: { min: range.minP, max: range.maxP, sum: range.sumP, count: range.countP },
        temp: { min: range.minT, max: range.maxT, sum: range.sumT, count: range.countT },
      };
      powerAvg = range.countP > 0 ? range.sumP / range.countP : null;
      tempAvg = range.countT > 0 ? range.sumT / range.countT : null;
      displayPowerAvg = powerAvg;
      displayTempAvg = tempAvg;
    }
  } else {
    cancelRangeStatsJob();
    setRangeStatsPending(false);
    const label = document.getElementById('stats-snapshot-label');
    if (label) label.hidden = true;
  }

  /** @param {string} id @param {number} val @param {number} [decimals=3] */
  const setText = (id, val, decimals = 3) => {
    const el = document.getElementById(id);
    setTextIfChanged(el, Number.isFinite(val) ? val.toFixed(decimals) : '--');
  };

  setText('min-voltage', displayStats.voltage.min);
  setText('max-voltage', displayStats.voltage.max);
  setText('min-current', displayStats.current.min);
  setText('max-current', displayStats.current.max);
  setText('min-power', displayStats.power.min);
  setText('max-power', displayStats.power.max);

  /** @param {number|null} val @returns {val is number} */
  const isAvg = (val) => val !== null && Number.isFinite(val);

  const avgVoltage = displayStats.voltage.count > 0 ? displayStats.voltage.sum / displayStats.voltage.count : null;
  const avgCurrent = displayStats.current.count > 0 ? displayStats.current.sum / displayStats.current.count : null;
  const avgVoltageEl = document.getElementById('avg-voltage');
  const avgCurrentEl = document.getElementById('avg-current');
  setTextIfChanged(avgVoltageEl, isAvg(avgVoltage) ? avgVoltage.toFixed(3) : '--');
  setTextIfChanged(avgCurrentEl, isAvg(avgCurrent) ? Math.abs(avgCurrent).toFixed(3) : '--');

  const avgPowerEl = document.getElementById('avg-power');
  setTextIfChanged(avgPowerEl, isAvg(displayPowerAvg) ? displayPowerAvg.toFixed(3) : '--');

  const tempStats = displayStats.temp || state.stats.temp;
  setText('min-temp', tempStats.min, 1);
  setText('max-temp', tempStats.max, 1);

  const avgTempEl = document.getElementById('avg-temp');
  setTextIfChanged(avgTempEl, isAvg(displayTempAvg) ? displayTempAvg.toFixed(1) : '--');

  /** 「(N点)」标签仍是原始行数，这里说明均值实际只折入了有限值。 */
  const setSkipTip = (id, count) => {
    const el = document.getElementById(id);
    const title = count > 0 ? t('missingSamples', { count }) : '';
    if (el && el.title !== title) el.title = title;
  };
  setSkipTip('avg-voltage', skipped.voltage);
  setSkipTip('avg-current', skipped.current);
  setSkipTip('avg-power', skipped.power);
  setSkipTip('avg-temp', skipped.temp);
}

/** 更新能量显示（支持范围模式）。 */
export function updateEnergyDisplay() {
  if (!monitorDisplayVisible()) {
    cancelRangeStatsJob();
    return;
  }
  let { wh, mah } = state.energy;

  // 范围模式下累计量也只统计选中区间，与最值/均值口径一致。
  if (state.settings.statsRange && state.chartSeries.x.length > 0) {
    const range = getDisplayRangeStats();
    setRangeStatsPending(!range);
    if (!range) {
      setMeter('lv-energy', 'energy', Number.NaN, 'x');
      setMeter('lv-capacity', 'capacity', Number.NaN, 'x');
      return;
    }
    if (range) {
      wh = range.wh;
      mah = range.mah;
    }
  } else {
    cancelRangeStatsJob();
    setRangeStatsPending(false);
  }

  const whEl = document.getElementById('rt-energy');
  const mahEl = document.getElementById('rt-capacity');
  setTextIfChanged(whEl, wh.toFixed(4));
  setTextIfChanged(mahEl, mah.toFixed(2));
  setMeter('lv-energy', 'energy', wh, 'x');
  setMeter('lv-capacity', 'capacity', mah, 'x');
}

// ─── Throttled stats refresh ─────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let __statsUpdateTimer = null;
/** @type {boolean} */
let __rangeUiPending = false;
let __rangeUiGeneration = 0;
/** @type {Parameters<typeof updateRealtimeDisplay>[0]|null} */
let lastRealtime = null;

/**
 * Device batches are consumed point by point, but display work is submitted once per batch.
 * The flags keep the hot path free of rAF/timer registration while preserving every state
 * update and making a partial batch visible if ingestion reports an error.
 */
let ingestBatchDepth = 0;
let ingestBatchRangeDirty = false;
let ingestBatchStatsDirty = false;
let ingestBatchChartDirty = false;
let ingestBatchStartedAt = 0;

function beginIngestBatch() {
  if (ingestBatchDepth++ === 0) {
    ingestBatchStartedAt = performance.now();
    ingestBatchRangeDirty = false;
    ingestBatchStatsDirty = false;
    ingestBatchChartDirty = false;
  }
}

function endIngestBatch() {
  if (ingestBatchDepth <= 0) return;
  if (--ingestBatchDepth > 0) return;
  const rangeDirty = ingestBatchRangeDirty;
  const statsDirty = ingestBatchStatsDirty;
  const chartDirty = ingestBatchChartDirty;
  ingestBatchRangeDirty = false;
  ingestBatchStatsDirty = false;
  ingestBatchChartDirty = false;
  if (rangeDirty) scheduleRangeUi();
  if (statsDirty) scheduleStatsUpdate();
  if (chartDirty) scheduleChartUpdate();
  performanceDiagnostics.domCommit('ingest-batch-submit', ingestBatchStartedAt);
}

function scheduleChartUpdate() {
  if (ingestBatchDepth > 0) {
    ingestBatchChartDirty = true;
    return;
  }
  requestChartUpdate();
}

/**
 * 最近一个点的显示值（电流按「记录电流方向」处理、功率取幅值），没有数据时为 null。
 * 协议控制页的读数条用它，不另开订阅。
 */
export function getLastRealtime() {
  return lastRealtime;
}

/**
 * 范围标签与点数：跟 rAF 走，不跟每个采样点走。
 */
export function scheduleRangeUi() {
  if (ingestBatchDepth > 0) {
    ingestBatchRangeDirty = true;
    return;
  }
  if (__rangeUiPending) return;
  __rangeUiPending = true;
  const generation = __rangeUiGeneration;
  displayFrames.schedule('monitor-ui', () => {
    const startedAt = performance.now();
    if (generation !== __rangeUiGeneration) return;
    __rangeUiPending = false;
    if (monitorDisplayVisible()) {
      if (lastRealtime) updateRealtimeDisplay(lastRealtime);
      if (!state.__rangeDragging) updateChartRange();
      updateChartEmptyState();
    }
    updateDurationDisplay();
    const el = document.getElementById('data-count');
    setTextIfChanged(el, String(state.chartSeries.x.length));
    updateRemainingDisplay();
    performanceDiagnostics.domCommit('monitor-ui', startedAt);
  });
}

/** 页面或窗口重新可见时先同步窗口，再交给图表同一帧补绘。 */
export function refreshMonitorDisplay() {
  if (!monitorDisplayVisible()) return;
  // 待执行的旧帧和统计定时器已有这一份完整结果，避免恢复时重复提交。
  __rangeUiGeneration++;
  __rangeUiPending = false;
  displayFrames.cancel('monitor-ui');
  if (__statsUpdateTimer !== null) {
    clearTimeout(__statsUpdateTimer);
    __statsUpdateTimer = null;
  }
  if (!state.__rangeDragging) updateChartRange();
  else updateSliderFill();
  if (lastRealtime) updateRealtimeDisplay(lastRealtime);
  else paintRealtimeEmptyCards();
  updateChartEmptyState();
  updateStatsDisplay();
  updateEnergyDisplay();
  updateDurationDisplay();
  setTextIfChanged(document.getElementById('data-count'), String(state.chartSeries.x.length));
}

/**
 * 节流版 updateStatsDisplay（含能量显示）。
 * 范围统计需要 O(可见点数) 的遍历，流式采样不需要每个点都同步重扫。
 * 250ms 的上限刷新间隔保持 UI 可读性，同时避免长录制时主线程被统计占满。
 */
export function scheduleStatsUpdate() {
  if (ingestBatchDepth > 0) {
    ingestBatchStatsDirty = true;
    return;
  }
  if (!monitorDisplayVisible()) {
    cancelRangeStatsJob();
    return;
  }
  if (!state.settings.statsRange) cancelRangeStatsJob();
  if (__statsUpdateTimer !== null) return;
  if (state.settings.statsRange) markStaleRangeStatsPending();
  __statsUpdateTimer = setTimeout(
    () => {
      const startedAt = performance.now();
      __statsUpdateTimer = null;
      updateStatsDisplay();
      updateEnergyDisplay();
      performanceDiagnostics.domCommit('stats-ui', startedAt);
    },
    state.settings.statsRange ? Math.max(250, rangeCalculationMs * 4) : 250,
  );
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
function paintRealtimeEmptyCards() {
  /** @param {string} id */
  const dash = (id) => {
    const el = document.getElementById(id);
    setTextIfChanged(el, '--');
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
  if (dirEl && !dirEl.hidden) dirEl.hidden = true;
  resetMeters();
}

/** 把实时卡片清成占位，避免清空 / 导入后仍显示上一轮活点。 */
export function resetRealtimeCards() {
  lastRealtime = null;
  if (monitorDisplayVisible()) paintRealtimeEmptyCards();
  else for (const key of Object.keys(meterPeak)) meterPeak[key] = 0;
}

/** 清空图表数据和相关状态。 */
export function clearChart() {
  // 先收尾这份记录的临时文件：它引用的是即将换掉的列，写完再关。
  void finalizeSpool();
  cancelRangeStatsJob();
  setRangeStatsPending(false);
  void stopRecording({ discard: true }).catch(() => {});
  deviceStream.replace();
  setChartColumns(emptyChartColumns());
  rangeStatsCache = null;
  rangeStartedColumns = null;
  rangeStartedRevision = -1;
  rangeStartedWindow = '';
  rangeStartedAt = -Infinity;
  rangeCalculationMs = 0;
  state.dataIntervalMs = null;
  state.lastRecordingStartTime = null;
  state.recordingBaseSeconds = 0;
  state.chartWindow = emptyChartWindow();
  writePermille(0, 1000);
  updateSliderFill();
  resetRealtimeCards();
  updateChartEmptyState();
  updateDurationDisplay();

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
  updateRemainingDisplay();
}

// ─── Recording control ───────────────────────────────────────────────────────

/** 防止连点在 await PD 门期间重入。 */
let recordingStartLock = false;
let recordingEpoch = 0;

/** 开始录制。原生段由读线程开启；取消令牌防止异步开始在清空/导入后复活。 */
export async function startRecording() {
  if (!state.isConnected) {
    console.warn('Attempted to start recording while not connected');
    return;
  }
  if (state.isRecording || recordingStartLock) return;
  if (state.chartSeries.x.length >= recordLimitPoints()) {
    toast.warning(() => t('limitContinue'));
    return;
  }

  recordingStartLock = true;
  const epoch = ++recordingEpoch;
  const columns = state.chartSeries;
  try {
    if (deviceStream.enabled) {
      await deviceStream.settle();
    } else {
      await invokeCmd('set_pd_capture_enabled', { enabled: true });
    }
    if (epoch !== recordingEpoch || columns !== state.chartSeries || !state.isConnected || state.isRecording) return;

    state.isRecording = true;
    const now = Date.now();
    state.recordingStartTime = now;
    if (state.chartSeries.timestamps.length === 0) {
      state.lastRecordingStartTime = now;
      state.recordingBaseSeconds = 0;
    } else {
      const lastX = state.chartSeries.x.at(-1);
      state.recordingBaseSeconds =
        (Number.isFinite(lastX) ? lastX : 0) + Math.max(state.settings.sampleRate / 1000, 0.001);
      if (state.lastRecordingStartTime === null) state.lastRecordingStartTime = state.chartSeries.timestamps.at(0);
    }
    // 暂停期间不属于下一段能量积分区间。
    state.energy.lastX = null;
    state.autoPauseSettings.triggerStartTime = null;

    const el = document.getElementById('record-status');
    if (el) el.textContent = t('recording');

    spoolRecordingStarted();
    startDurationTicker();
    updateChartEmptyState();

    refreshRecordButton();
    const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
    if (btnClear) btnClear.disabled = true;

    // 通知 PD 视图等订阅方（可选调用：node 测试的 document stub 没有 dispatchEvent）
    document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
    if (deviceStream.enabled) await deviceStream.begin(state.recordingBaseSeconds);
  } catch (error) {
    console.error('Recording start failed:', error);
    if (epoch === recordingEpoch) void stopRecording({ discard: true }).catch(() => {});
  } finally {
    if (epoch === recordingEpoch) recordingStartLock = false;
  }
}

/** UI state changes synchronously; the returned promise fences the retained tail.
 * @param {{discard?:boolean}} [options]
 */
export function stopRecording({ discard = false } = {}) {
  recordingEpoch++;
  recordingStartLock = false;
  const paused = deviceStream.enabled
    ? deviceStream.pause({ discard, pdEnabled: !state.settings.pdFollowRecording })
    : Promise.resolve();
  if (!state.isRecording) return paused;

  state.isRecording = false;
  state.recordingStartTime = null;
  state.energy.lastX = null;
  state.autoPauseSettings.triggerStartTime = null;
  // 落盘在读线程排空后的尾部点到达前就开始同步；之后到达的尾点由下一次追加或收尾写入。
  void paused.then(spoolRecordingPaused, spoolRecordingPaused);

  const el = document.getElementById('record-status');
  if (el) el.textContent = t('stopRecording');

  stopDurationTicker();

  refreshRecordButton();
  const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
  if (btnClear) btnClear.disabled = false;

  state.__setRangeControlsEnabled?.(true);
  // 暂停时补上最后一帧，密集回看继续遵循当前显示预算。
  updateCharts();

  // 跟随记录关闭时采集门保持开；开启时与本地 isRecording 一起关掉。
  if (!deviceStream.enabled) {
    void invokeCmd('set_pd_capture_enabled', { enabled: !state.settings.pdFollowRecording }).catch(console.error);
  }
  updateStatsDisplay();
  updateEnergyDisplay();

  // 单一咽喉点：手动停止 / 自动暂停 / 拔设备 / CSV 导入引发的停止都会走到这里
  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
  return paused;
}

/** 清空图表并重置统计和能量。 */
export function clearAndResetStats() {
  clearChart();
  resetStats();
  resetEnergy();
}
