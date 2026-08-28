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

/** 相邻采样点超过该秒数视为中断（休眠 / NTP / 漏采），不把空档积进 Wh/mAh。 */
export const MAX_ENERGY_STEP_S = 2;

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

/**
 * 按相邻采样点积分能量和容量。录制会话边界由调用方通过分段重置时间基线保证；
 * 这里仅跳过倒序、非有限或缺失值区间。直播路径的休眠空档由 {@link nextRecordingX} 先夹掉。
 * @param {number[]} timestamps 毫秒时间戳
 * @param {number[]} current
 * @param {number[]} power
 * @returns {{ wh: number, mah: number }}
 */
export function calculateEnergy(timestamps, current, power) {
  return integrateEnergy(timestamps, current, power, 3600000, 0, timestamps.length - 1);
}

/**
 * 在索引区间 [startIndex, endIndex] 上积分能量和容量。
 * 时间轴取相对秒（chartSeries.x）而非挂钟时间戳：相对秒不含录制暂停留下的空档，
 * 与实时累计口径一致；用时间戳会把暂停时长当作持续放电计入。
 * @param {number[]} seconds 相对秒序列
 * @param {number[]} current
 * @param {number[]} power
 * @param {number} startIndex
 * @param {number} endIndex
 * @returns {{ wh: number, mah: number }}
 */
export function calculateEnergyInRange(seconds, current, power, startIndex, endIndex) {
  return integrateEnergy(seconds, current, power, 3600, startIndex, endIndex);
}

/**
 * @param {number[]} times
 * @param {number[]} current
 * @param {number[]} power
 * @param {number} perHour 时间轴单位换算到小时的除数
 * @param {number} startIndex
 * @param {number} endIndex
 * @returns {{ wh: number, mah: number }}
 */
function integrateEnergy(times, current, power, perHour, startIndex, endIndex) {
  let wh = 0;
  let mah = 0;
  // 区间首点只提供积分起点，第一段区间从 startIndex+1 开始。
  const from = Math.max(0, startIndex) + 1;
  const to = Math.min(endIndex, times.length - 1);
  for (let i = from; i <= to; i++) {
    const dt = (times[i] - times[i - 1]) / perHour;
    const currentValue = Math.abs(current[i]);
    const powerValue = Math.abs(power[i]);
    if (dt < 0 || !Number.isFinite(dt) || !Number.isFinite(currentValue) || !Number.isFinite(powerValue)) continue;
    wh += powerValue * dt;
    mah += currentValue * 1000 * dt;
  }
  return { wh, mah };
}

/**
 * 从唯一的图表数据源生成导出行，避免录制缓冲与图表内容分叉。
 * @param {{ timestamps: number[], voltage: number[], current: number[], power: number[], temp: number[], dp: number[], dn: number[], cc1: number[], cc2: number[] }} chartData
 * @param {{ x: number[] }} chartSeries
 * @returns {{ relSeconds: number, voltage: number, current: number, power: number, temp: number, dp: number, dn: number, cc1: number, cc2: number }[]}
 */
export function buildExportRows(chartData, chartSeries) {
  return chartSeries.x.map((relSeconds, i) => ({
    relSeconds,
    voltage: chartData.voltage[i],
    current: chartData.current[i],
    power: chartData.power[i],
    temp: chartData.temp[i],
    dp: chartData.dp[i],
    dn: chartData.dn[i],
    cc1: chartData.cc1[i],
    cc2: chartData.cc2[i],
  }));
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
