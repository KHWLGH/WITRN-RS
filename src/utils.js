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

/**
 * 按采样率下拉框的既有文案约定，把采样间隔渲染成「N 次/秒」。
 * @param {number} intervalMs - 采样间隔（毫秒）
 * @returns {string}
 */
export function formatSampleRateLabel(intervalMs) {
  const perSecond = Number((1000 / intervalMs).toFixed(2));
  return intervalMs > 1000
    ? `${perSecond} 次/秒 (${Number((intervalMs / 1000).toFixed(2))}秒1次)`
    : `${perSecond} 次/秒`;
}

/**
 * 把采样率写入下拉框。
 *
 * 后端与设置允许 10..60000ms 的任意值（CSV 导入会带进预设之外的采样率），
 * 而下拉框只列了 6 个常用档位。直接赋一个不在列表里的值会让 selectedIndex
 * 变成 -1、控件显示空白，所以这里按需补一个表示实际值的选项。
 *
 * @param {HTMLSelectElement} select
 * @param {number} intervalMs
 */
export function setSampleRateOption(select, intervalMs) {
  const value = String(intervalMs);
  if (!Array.from(select.options).some((o) => o.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = formatSampleRateLabel(intervalMs);
    // 按间隔升序插入，与预设选项的排列保持一致。
    const after = Array.from(select.options).find((o) => Number(o.value) > intervalMs);
    select.insertBefore(option, after ?? null);
  }
  select.value = value;
}
