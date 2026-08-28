// @ts-check
/**
 * 主图 X 窗纯函数：绕光标缩放、钳位、full / follow / frozen 判定。
 * 不碰 DOM、不碰 Tauri，供 data.js 与单测共用。
 */

/**
 * @typedef {'full'|'follow'|'frozen'} ChartWindowMode
 * @typedef {{ mode: ChartWindowMode, duration: number, min: number, max: number }} ChartWindow
 */

/** @returns {ChartWindow} */
export function emptyChartWindow() {
  return { mode: 'full', duration: 0, min: 0, max: 0 };
}

/**
 * 滚轮缩进的最小时间跨度（秒）：至少 0.1s，且至少覆盖约两个采样间隔。
 * @param {number} sampleRateMs
 */
export function minZoomSpan(sampleRateMs) {
  const step = Math.max(Number(sampleRateMs) || 0, 1) / 1000;
  return Math.max(0.1, 2 * step);
}

/**
 * 把 wheel 的 deltaY 换成跨度乘数（>1 拉远，<1 拉近）。
 * @param {number} deltaY
 * @param {number} [deltaMode=0]
 */
export function wheelZoomFactor(deltaY, deltaMode = 0) {
  const dy = Number(deltaY);
  if (!Number.isFinite(dy) || dy === 0) return 1;
  const pixels = deltaMode === 1 ? dy * 16 : deltaMode === 2 ? dy * 400 : dy;
  return Math.exp(pixels * 0.0015);
}

/**
 * 绕 pivot 缩放 [min, max]，结果钳在数据范围且不短于 minSpan。
 * @param {{
 *   min: number, max: number, pivot: number, factor: number,
 *   dataMin: number, dataMax: number, minSpan: number,
 * }} args
 * @returns {{ min: number, max: number }}
 */
export function zoomTimeWindow(args) {
  const dataMin = args.dataMin;
  const dataMax = args.dataMax;
  const dataSpan = dataMax - dataMin;
  if (!(dataSpan > 0)) return { min: dataMin, max: dataMax };

  let span = args.max - args.min;
  if (!(span > 0) || !Number.isFinite(span)) span = dataSpan;

  let factor = args.factor;
  if (!(factor > 0) || !Number.isFinite(factor)) factor = 1;

  const minSpan = Math.max(Number(args.minSpan) || 0, Number.EPSILON);
  let nextSpan = span * factor;
  if (nextSpan < minSpan) nextSpan = minSpan;
  if (nextSpan > dataSpan) nextSpan = dataSpan;

  let pivot = args.pivot;
  if (!Number.isFinite(pivot)) pivot = (args.min + args.max) / 2;
  pivot = Math.min(dataMax, Math.max(dataMin, pivot));

  const leftRatio = span > 0 ? (pivot - args.min) / span : 0.5;
  const ratio = Number.isFinite(leftRatio) ? Math.min(1, Math.max(0, leftRatio)) : 0.5;
  let nextMin = pivot - nextSpan * ratio;
  let nextMax = nextMin + nextSpan;

  if (nextMin < dataMin) {
    nextMin = dataMin;
    nextMax = nextMin + nextSpan;
  }
  if (nextMax > dataMax) {
    nextMax = dataMax;
    nextMin = nextMax - nextSpan;
  }
  if (nextMin < dataMin) nextMin = dataMin;
  return { min: nextMin, max: nextMax };
}

/**
 * 按窗口相对数据首尾的位置判定 full / follow / frozen。
 * @param {number} min
 * @param {number} max
 * @param {number} dataMin
 * @param {number} dataMax
 * @param {number} [edgeEps]
 * @returns {ChartWindow}
 */
export function classifyChartWindow(min, max, dataMin, dataMax, edgeEps) {
  const span = dataMax - dataMin;
  if (!(span > 0) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return { mode: 'full', duration: Math.max(0, span), min: dataMin, max: dataMax };
  }
  let a = min;
  let b = max;
  if (a > b) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  let eps = Math.max(span * 1e-4, 1e-6);
  if (typeof edgeEps === 'number' && Number.isFinite(edgeEps) && edgeEps > 0) eps = edgeEps;
  const atStart = a <= dataMin + eps;
  const atEnd = b >= dataMax - eps;
  if (atStart && atEnd) {
    return { mode: 'full', duration: span, min: dataMin, max: dataMax };
  }
  if (atEnd) {
    const duration = Math.max(0, b - a);
    return { mode: 'follow', duration, min: Math.max(dataMin, dataMax - duration), max: dataMax };
  }
  return {
    mode: 'frozen',
    duration: Math.max(0, b - a),
    min: Math.min(dataMax, Math.max(dataMin, a)),
    max: Math.min(dataMax, Math.max(dataMin, b)),
  };
}

/**
 * 数据右沿增长时推进窗口：follow 保 duration，frozen 保秒值，full 跟全历史。
 * @param {ChartWindow|null|undefined} win
 * @param {number} dataMin
 * @param {number} dataMax
 * @returns {ChartWindow}
 */
export function resolveChartWindow(win, dataMin, dataMax) {
  const span = dataMax - dataMin;
  if (!(span > 0) || !win || win.mode === 'full') {
    return { mode: 'full', duration: Math.max(0, span), min: dataMin, max: dataMax };
  }
  if (win.mode === 'follow') {
    const duration = win.duration > 0 ? win.duration : Math.max(0, win.max - win.min);
    if (!(duration > 0) || duration >= span) {
      return { mode: 'full', duration: span, min: dataMin, max: dataMax };
    }
    const max = dataMax;
    const min = Math.max(dataMin, max - duration);
    return { mode: 'follow', duration, min, max };
  }
  let min = win.min;
  let max = win.max;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { mode: 'full', duration: span, min: dataMin, max: dataMax };
  }
  if (min < dataMin) min = dataMin;
  if (max > dataMax) max = dataMax;
  if (max <= min) {
    return { mode: 'full', duration: span, min: dataMin, max: dataMax };
  }
  return { mode: 'frozen', duration: max - min, min, max };
}

/**
 * 平移千分比选区，跨度不变，钳在 0–1000。
 * @param {number} start
 * @param {number} end
 * @param {number} delta
 * @returns {{ start: number, end: number }}
 */
export function panPermilleWindow(start, end, delta) {
  const s = Math.min(1000, Math.max(0, start | 0));
  const e = Math.min(1000, Math.max(s, end | 0));
  const span = e - s;
  if (span <= 0 || span >= 1000) return { start: s, end: e };
  const d = Number.isFinite(delta) ? Math.round(delta) : 0;
  let nextStart = s + d;
  if (nextStart < 0) nextStart = 0;
  if (nextStart + span > 1000) nextStart = 1000 - span;
  return { start: nextStart, end: nextStart + span };
}
