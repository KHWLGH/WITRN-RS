// @ts-check
/**
 * @file 单次记录上限：MB ↔ 点数 ↔ 时长的换算与剩余量，纯函数。
 *
 * 内存按 112 字节 / 点估算：12 列 Float64（96 B），另计分块余量与极值索引。
 * 落盘 CSV 按 128 字节 / 行估算（带温度、段号及逐点间隔）。界面标「约」。
 */

export const BYTES_PER_POINT = 112;
export const CSV_BYTES_PER_ROW = 128;
export const LIMIT_MB_MIN = 64;
export const LIMIT_MB_MAX = 8192;
export const DEFAULT_LIMIT_MB = 512;
/** 用到这个比例时提前提示一次。 */
export const WARN_FRACTION = 0.9;

const MB = 1024 * 1024;

/**
 * 钳到 64–8192 MB 的整数；非数值回落默认值。
 * @param {unknown} value
 */
export function clampLimitMb(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT_MB;
  return Math.round(Math.min(LIMIT_MB_MAX, Math.max(LIMIT_MB_MIN, n)));
}

/** @param {number} mb */
export function pointsForLimit(mb) {
  return Math.floor((clampLimitMb(mb) * MB) / BYTES_PER_POINT);
}

/**
 * 「2 小时 13 分」「45 分 30 秒」「3 天 4 小时」这类大约时长。
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 「537 万点」「8,400 点」 @param {number} points */
export function formatPoints(points) {
  const n = Math.max(0, Math.floor(points));
  return n >= 10_000 ? `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万点` : `${n.toLocaleString('en-US')} 点`;
}

/** @param {number} bytes */
export function formatMegabytes(bytes) {
  const mb = bytes / MB;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

/**
 * 设置页说明：上限对应的点数、按当前采样率能记多久、对应落盘文件多大。
 * @param {number} mb
 * @param {number} rateMs 采样间隔（毫秒）
 */
export function describeLimit(mb, rateMs) {
  const points = pointsForLimit(mb);
  const perSecond = rateMs > 0 ? 1000 / rateMs : 0;
  const rate =
    perSecond >= 1 ? `${Number(perSecond.toFixed(2))} 次/秒` : `${Number((rateMs / 1000).toFixed(2))} 秒 1 次`;
  return `约 ${formatPoints(points)}；按当前 ${rate} 约可记录 ${formatDuration((points * rateMs) / 1000)}，落盘 CSV 约 ${formatMegabytes(points * CSV_BYTES_PER_ROW)}。`;
}

/**
 * 底栏剩余提示。
 * @param {number} used 已记录点数
 * @param {number} limit 上限点数
 * @param {number} rateMs 采样间隔（毫秒）
 */
export function remainingInfo(used, limit, rateMs) {
  const remaining = Math.max(0, limit - used);
  const fraction = limit > 0 ? remaining / limit : 0;
  const seconds = rateMs > 0 ? (remaining * rateMs) / 1000 : 0;
  const full = remaining === 0;
  return {
    remaining,
    fraction,
    full,
    warn: fraction < 1 - WARN_FRACTION,
    text: full ? '已满' : `${Math.floor(fraction * 100)}% · 约 ${formatDuration(seconds)}`,
    title: `已用 ${formatPoints(used)} / 上限 ${formatPoints(limit)}（约 ${formatMegabytes(used * BYTES_PER_POINT)} / ${formatMegabytes(limit * BYTES_PER_POINT)}）`,
  };
}
