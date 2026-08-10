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
 * 按相邻采样点积分能量和容量。录制会话边界由调用方通过分段重置时间基线保证；
 * 这里仅跳过倒序、非有限或缺失值区间。
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
 * @param {{ timestamps: number[], voltage: number[], current: number[], power: number[], temp: number[] }} chartData
 * @param {{ x: number[] }} chartSeries
 * @returns {{ relSeconds: number, voltage: number, current: number, power: number, temp: number }[]}
 */
export function buildExportRows(chartData, chartSeries) {
  return chartSeries.x.map((relSeconds, i) => ({
    relSeconds,
    voltage: chartData.voltage[i],
    current: chartData.current[i],
    power: chartData.power[i],
    temp: chartData.temp[i],
  }));
}
