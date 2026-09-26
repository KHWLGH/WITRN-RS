// @ts-check
/**
 * @file 可脱离 DOM/Tauri 测试的测量数据纯函数。
 */

/**
 * 解析官方和本应用使用的相对时间标签。
 * @param {string} label
 * @returns {number|null}
 */
export function parseRelativeTime(label) {
  const text = String(label).replace(/[="]/g, '').trim();
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return null;

  const seconds =
    (match[1] ? Number.parseInt(match[1], 10) * 86400 : 0) +
    Number.parseInt(match[2], 10) * 3600 +
    Number.parseInt(match[3], 10) * 60 +
    Number.parseFloat(match[4]);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * 把正数取到 1-2-5 系列的上档，供读数栏电平条自动量程使用。
 * 12.3 → 20，3.4 → 5，31 → 50；非正数或非有限值返回 1。
 * @param {number} value
 * @returns {number}
 */
export function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const mag = 10 ** exp;
  const mantissa = value / mag;
  const nice = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10;
  return nice * mag;
}

/** 相邻采样点超过该秒数视为中断（休眠 / NTP / 漏采），不把空档积进 Wh/mAh。
 * 这是**下限**：慢采样档必须按标称间隔放宽，否则每一步都会被当成空档，能量恒为 0。 */
export const MAX_ENERGY_STEP_S = 2;

/** 空档阈值相对标称采样间隔的倍数，与 {@link nextRecordingX} 放行 x 轴的倍数保持一致，
 * 否则会出现「点被画进 x 轴、却被积分器拒收」的口径分裂。 */
export const ENERGY_STEP_INTERVAL_MULTIPLIER = 8;

/** `set_sample_rate` 实际接受的区间，用于夹住从数据里反推出的标称间隔。 */
const SAMPLE_RATE_BOUNDS_MS = [10, 60000];

/**
 * 标称采样间隔对应的空档阈值（秒）。未知或非法间隔回落到 {@link MAX_ENERGY_STEP_S}，
 * 即保持旧的绝对 2 秒口径，绝不因此关闭守卫。
 * @param {number|null|undefined} intervalMs
 * @returns {number}
 */
export function energyMaxStepS(intervalMs) {
  const seconds = Number(intervalMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return MAX_ENERGY_STEP_S;
  return Math.max(MAX_ENERGY_STEP_S, ENERGY_STEP_INTERVAL_MULTIPLIER * seconds);
}

/**
 * 从相对秒序列反推标称采样间隔（毫秒）。取前若干个正步长的中位数，
 * 这样休眠空档与乱序/缺失点都不会把估计值拉高。
 * @param {ArrayLike<number>} xSeconds
 * @returns {number|null} 没有可用步长时为 null；否则夹到设备接受的 10–60000 ms
 */
export function estimateIntervalMsFromX(xSeconds) {
  const steps = [];
  for (let i = 1; i < xSeconds.length && steps.length < 200; i++) {
    const prev = xSeconds[i - 1];
    const delta = xSeconds[i] - prev;
    if (Number.isFinite(delta) && delta > 0) steps.push(delta * 1000);
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => a - b);
  const median = steps[(steps.length - 1) >> 1];
  return Math.min(SAMPLE_RATE_BOUNDS_MS[1], Math.max(SAMPLE_RATE_BOUNDS_MS[0], median));
}

/** Native monotonic deltas retain real gaps; the existing integration guard skips >2s.
 * Wall time is reconstructed from one connection anchor, not batch arrival or NTP.
 * @param {import('./device-stream.js').StreamSample} sample
 * @param {number} baseSeconds
 */
export function streamSampleTime(sample, baseSeconds) {
  return {
    wallMs: sample.wall_anchor_ms + sample.received_us / 1000,
    seconds: baseSeconds + Math.max(0, (sample.received_us - sample.segment_start_us) / 1_000_000),
  };
}

/**
 * 把下一点的相对秒限制在采样间隔附近：时钟回拨时前进一个间隔，
 * 休眠或 NTP 前跳时也不把空档写进 x 轴。
 * @param {number} prevX
 * @param {number} relSeconds
 * @param {number} sampleRateMs
 * @returns {number}
 */
export function nextRecordingX(prevX, relSeconds, sampleRateMs) {
  const minStep = Math.max(Number(sampleRateMs) / 1000, 0.001);
  const maxStep = Math.max(minStep * 8, MAX_ENERGY_STEP_S);
  if (!Number.isFinite(prevX)) return relSeconds;
  if (relSeconds <= prevX) return prevX + minStep;
  if (relSeconds - prevX > maxStep) return prevX + minStep;
  return relSeconds;
}

/** @param {ArrayLike<number>|null} segments @param {number} index */
export function isRecordingBoundary(segments, index) {
  return segments != null && Number.isFinite(segments[index]) && segments[index] !== segments[index - 1];
}

/**
 * @param {ArrayLike<number>} timestamps 毫秒时间戳
 * @param {ArrayLike<number>} current
 * @param {ArrayLike<number>} power
 * @param {ArrayLike<number>|null} [segments=null]
 * @param {number|null} [intervalMs=null] 标称采样间隔，决定空档阈值；null 用绝对 2 秒
 */
export function calculateEnergy(timestamps, current, power, segments = null, intervalMs = null) {
  return integrateEnergy(
    timestamps,
    current,
    power,
    3600000,
    0,
    timestamps.length - 1,
    segments,
    energyMaxStepS(intervalMs),
  );
}

/**
 * @param {ArrayLike<number>} seconds 相对秒序列
 * @param {ArrayLike<number>} current
 * @param {ArrayLike<number>} power
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {ArrayLike<number>|null} [segments=null]
 * @param {number|null} [intervalMs=null] 标称采样间隔，决定空档阈值；null 用绝对 2 秒
 */
export function calculateEnergyInRange(
  seconds,
  current,
  power,
  startIndex,
  endIndex,
  segments = null,
  intervalMs = null,
) {
  return integrateEnergy(seconds, current, power, 3600, startIndex, endIndex, segments, energyMaxStepS(intervalMs));
}

/**
 * @param {ArrayLike<number>} times
 * @param {ArrayLike<number>} current
 * @param {ArrayLike<number>} power
 * @param {number} perHour
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {ArrayLike<number>|null} segments
 * @param {number} maxStepS 空档阈值（秒）
 */
function integrateEnergy(times, current, power, perHour, startIndex, endIndex, segments, maxStepS) {
  let wh = 0;
  let mah = 0;
  const from = Math.max(0, startIndex) + 1;
  const to = Math.min(endIndex, times.length - 1);
  for (let i = from; i <= to; i++) {
    if (isRecordingBoundary(segments, i)) continue;
    const dt = (times[i] - times[i - 1]) / perHour;
    const currentValue = Math.abs(current[i]);
    const powerValue = Math.abs(power[i]);
    if (dt < 0 || !Number.isFinite(dt) || !Number.isFinite(currentValue) || !Number.isFinite(powerValue)) continue;
    if (dt * 3600 > maxStepS) continue;
    wh += powerValue * dt;
    mah += currentValue * 1000 * dt;
  }
  return { wh, mah };
}

/**
 * 解析 CSV 表头行，定位可选列的下标（-1 = 该列不存在）。
 * 电压/电流/功率固定在 1/2/3 列（官方与本应用新旧格式一致），
 * 温度与 D+/D-/CC1/CC2 列的位置随格式版本变化，按表头名定位。
 * @param {string} headerLine
 * @returns {{ tempIdx: number, dpIdx: number, dnIdx: number, cc1Idx: number, cc2Idx: number }}
 */
export function mapCsvColumns(headerLine) {
  const cols = String(headerLine)
    .split(',')
    .map((c) => c.trim());
  /** @param {string} prefix */
  const find = (prefix) => cols.findIndex((c) => c.startsWith(prefix));
  return {
    tempIdx: find('Temp'),
    dpIdx: find('D+'),
    dnIdx: find('D-'),
    cc1Idx: find('CC1'),
    cc2Idx: find('CC2'),
  };
}
