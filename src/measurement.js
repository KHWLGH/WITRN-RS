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
 * @param {number[]} timestamps
 * @param {number[]} current
 * @param {number[]} power
 * @returns {{ wh: number, mah: number }}
 */
export function calculateEnergy(timestamps, current, power) {
  let wh = 0;
  let mah = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const dt = (timestamps[i] - timestamps[i - 1]) / 3600000;
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
