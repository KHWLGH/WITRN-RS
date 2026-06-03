// @ts-check
/**
 * @file 纯工具函数 — 无外部依赖，可被任意模块安全引用。
 */

/**
 * 将秒数格式化为 HH:mm:ss.s 相对时间字符串。
 * @param {number} seconds
 * @returns {string}
 */
export function formatRelativeHMS(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const totalTenths = Math.max(0, Math.round(safeSeconds * 10));

  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const secondsTenths = totalTenths % 600;
  const secs = Math.floor(secondsTenths / 10);
  const tenths = secondsTenths % 10;

  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}.${tenths}`;
}

/**
 * 将时间标签字符串转换为秒数（去除可能的 "s" 后缀）。
 * @param {string|number|null|undefined} label
 * @returns {number}
 */
export function labelToSeconds(label) {
  const text = String(label ?? '')
    .trim()
    .replace(/s$/i, '');
  const value = parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 将 HEX 颜色字符串转换为 rgba() 格式。
 * @param {string} hex - 例如 "#4a9eff"
 * @param {number} opacityPercent - 0-100
 * @returns {string}
 */
export function hexToRgba(hex, opacityPercent) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
}
