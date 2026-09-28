// @ts-check
/**
 * @file uPlot 图表初始化、渲染调度、交互（tooltip / 图例 / X 轴窗口）。
 *
 * uPlot 由 vendor/uPlot.iife.min.js 以全局变量方式载入（本地文件，无网络依赖）。
 * 数据为列式（columnar）格式：state.chartSeries = { x, voltage, current, power, temp, dp, dn, cc1, cc2 }，
 * 主图绑定可见窗口的有界原始列或 min/max 桶（[x, v, c, p, t, dp, dn, cc1, cc2]）。
 *
 * 对外 API：
 * - initChart()           初始化主图 + 导航图
 * - scheduleChartUpdate() rAF 节流刷新（流式追加数据用）
 * - updateCharts()        立即刷新
 * - syncChartSeries()     序列数组被整体替换（清空 / 导入 CSV）后重新绑定
 * 「画什么」只由可见窗口决定：窗口超过 1×绘图宽度时按 stripePpb(窗口, 宽度) 折叠 min/max 桶，
 * 全量仍在 chartSeries；拖动中与松手后走同一句，没有低质量的预览态。
 * 极值金字塔只作为速度选择器（见 extremaForStripes），换慢路径不改变产出值。
 * - setChartXWindow()     设置主图 X 轴可见窗口（范围滑块）
 * - setRangeDragging()    手柄拖动中推迟导航图重建与 Y 轴重算（不改变曲线内容）
 * - setSeriesVisible()    显示 / 隐藏某条曲线（对应 Y 轴自动跟随显隐）
 * - setSeriesFill()       设置某条曲线的填充不透明度（0 = 关闭填充）
 */

import {
  bucketCap,
  columnSpan,
  firstIndexAfter,
  firstIndexAtOrAfter,
  nearestIndex,
  SeriesBuckets,
  stripePpb,
} from './chart-buckets.js';
import { BLOCK_SIZE, ExactExtremaIndex } from './chart-extrema.js';
import { wheelZoomFactor } from './chart-window.js';
import { runCooperativeSlices } from './cooperative.js';
import { displayFrames } from './frame-scheduler.js';
import { state } from './state.js';
import { chartTheme, onThemeChange } from './theme.js';
import { formatRelativeHMS, hexToRgba } from './utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * 数据集顺序（与复选框 / 设置字段一一对应；uPlot series 下标 = 此下标 + 1）。
 * ⚠ 只允许追加，不允许重排：seriesMax[3]（功率）是导航图的量程来源。
 */
const FIELDS = ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];
const LABELS = ['电压', '电流', '功率', '温度', 'D+', 'D-', 'CC1', 'CC2'];
const UNITS = [' V', ' A', ' W', ' °C', ' V', ' V', ' V', ' V'];
/** 各 series 挂靠的 scale：D+/D-/CC1/CC2 复用电压 scale（不新增轴）。 */
const SERIES_SCALES = ['voltage', 'current', 'power', 'temp', 'voltage', 'voltage', 'voltage', 'voltage'];

const CHART_FONT_FALLBACK =
  "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif";
const MONO_FONT_FALLBACK =
  "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'Noto Sans Mono', 'DejaVu Sans Mono', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', monospace";
let CHART_FONT = CHART_FONT_FALLBACK;
let MONO_FONT = MONO_FONT_FALLBACK;

/**
 * Canvas 字体不会自动解析 CSS 的 var()，因此从同一组 CSS 令牌读取字体栈，
 * 让 uPlot 的坐标轴与应用界面保持一致。
 */
function syncChartFonts() {
  if (typeof document === 'undefined') return;
  const styles = getComputedStyle(document.documentElement);
  const uiFont = styles.getPropertyValue('--font-ui').trim();
  const monoFont = styles.getPropertyValue('--font-mono').trim();
  if (uiFont) CHART_FONT = uiFont;
  if (monoFont) MONO_FONT = monoFont;
}

/** X 轴刻度步长候选（秒）— 时间友好的取值（覆盖 0.1 秒到月级跨度）。 */
const TIME_INCRS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
  259200, 432000, 604800, 1209600, 2592000, 5184000, 8640000,
];

// ─── Module state ────────────────────────────────────────────────────────────

/** 主图数据（列式）：[x, voltage, current, power, temp, dp, dn, cc1, cc2]。 */
/** @typedef {number[]|Float64Array} ChartColView */
/** @type {ChartColView[]} */
let mainData = [[], [], [], [], [], [], [], [], []];
/** 导航图数据：[x, power]（短历史的有界拷贝或桶数组）。 */
/** @type {ChartColView[]} */
let navData = [[], []];

/** 范围滑块设定的主图 X 轴窗口；null 表示尚无数据（使用默认范围）。 */
/** @type {{ min: number|null, max: number|null }} */
const xWindow = { min: null, max: null };

/** 每条曲线的填充色（按 series 下标 1..8，null = 不填充；D+/D-/CC 叠加曲线不填充）。 */
/** @type {(string|null)[]} */
let fillStyles = [null, null, null, null, null, null, null, null, null];

/**
 * 每条曲线全量数据的最大值（按 series 下标 1..8）。
 * Y 轴量程基于全量数据而非可见窗口（与旧版 Chart.js 行为一致，避免拖动滑块时 Y 轴跳动）。
 */
/** @type {number[]} */
let seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
/** 每条曲线全量数据的最小值（温度轴需要保留负值）。 */
/** @type {number[]} */
let seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
/** 已扫描过最大值的数据长度（增量扫描游标）。 */
let scannedLen = 0;

/** 主图窗口级显示桶：可见窗口点数超过 1×宽度后启用，存储仍走全量列。 */
let displayBuckets = new SeriesBuckets();
// Small existing paths stay synchronous. Large replacements/window scans yield.
const COOPERATIVE_POINTS = 250_000;
/** @type {{generation: number, cancelled: boolean}|null} */
let historyWork = null;
/** @type {{generation: number, start: number, end: number, cap: number, cancelled: boolean}|null} */
let projectionWork = null;

function cancelPreparation() {
  if (historyWork) historyWork.cancelled = true;
  if (projectionWork) projectionWork.cancelled = true;
  historyWork = null;
  projectionWork = null;
  setPreparing(false);
}

/** @param {boolean} busy */
function setPreparing(busy) {
  document.getElementById('main-chart')?.setAttribute?.('aria-busy', String(busy));
}
/**
 * 金字塔冷建是 O(全量) 的一次性开销（实测 1M ≈ 26ms / 5M ≈ 118ms），只为这么密的条带付。
 * 已 warm 之后每个新块只有微秒级增量，所以下限可以放到 BLOCK_SIZE。
 */
const COLD_BUILD_PPB = 128;
const extremaIndex = new ExactExtremaIndex();
/** @typedef {'raw'|'window'} BoundKind */
/** @type {BoundKind} */
let boundKind = 'raw';
let rawStart = 0;
let rawEnd = 0;
/** 范围手柄是否正在拖动（推迟导航图重建与 Y 轴重算，不改变曲线内容）。 */
let rangeDragging = false;
/** 上次完整 apply 时的数据代数；主图绑定的正确性由 bindingCovers 判断，不记宽度。 */
let appliedMainGen = -1;
/** Last submitted X window; null invalidates reuse after replacing the source. */
/** @type {[number, number]|null} */
let appliedXRange = null;

/** 数据代数 — 序列数组被整体替换（清空 / 导入）时递增，用于跳过导航图不必要的重建。 */
let dataGen = 0;
/** 导航图最近一次 setData 时的代数与长度；仅数据变化时才重建导航图（X 窗口拖动不触碰它）。 */
let appliedNavGen = -1;
let appliedNavLen = -1;

let chartDirty = false;
const tooltipThemeGen = 0;
let chartFramePending = false;
let flushingChart = false;
let paintBatchId = 0;
/** @typedef {{ batchId: number, requestedAt: number, prepareMs: number|null }} PaintRequest */
/** @type {PaintRequest|null} */
let paintRequest = null;
/** @type {WeakMap<object, { first: PaintRequest, last: PaintRequest, count: number }>} */
const pendingDraws = new WeakMap();
let chartListenersRegistered = false;

function monitorVisible() {
  return state.settings.activeView === 'monitor' && !document.hidden;
}

/**
 * 导航图 minmax 桶。点数不超过 2×宽度时复制短列；超过后按桶聚合，
 * 新点只更新最后一桶，桶数超上限则两两合并。
 * @typedef {{ x0: number, x1: number, min: number, max: number, n: number }} NavBucket
 */
/** @type {NavBucket[]} */
let navBucketList = [];
let navPpb = 1;
let navSrcLen = 0;
/** @type {ChartColView} */
let navX = [];
/** @type {ChartColView} */
let navY = [];
/** @type {Float64Array|null} */
let navFlatX = null;
/** @type {Float64Array|null} */
let navFlatY = null;
let navFlatCap = 0;
let lastNavPaint = 0;
const NAV_PAINT_MIN_MS = 100;

function navMaxBuckets() {
  const host = document.getElementById('navigator-chart');
  const w = host?.clientWidth || 600;
  return Math.max(64, Math.floor(w * 2));
}

function resetNavBuckets() {
  navBucketList = [];
  navPpb = 1;
  navSrcLen = 0;
  navX = [];
  navY = [];
}

/** @param {number} x @param {number} p @param {number} cap */
function pushNavSample(x, p, cap) {
  const v = Number.isFinite(p) ? p : 0;
  const last = navBucketList[navBucketList.length - 1];
  if (last && last.n < navPpb) {
    last.x1 = x;
    if (v < last.min) last.min = v;
    if (v > last.max) last.max = v;
    last.n++;
  } else {
    navBucketList.push({ x0: x, x1: x, min: v, max: v, n: 1 });
    if (navBucketList.length > cap) {
      /** @type {NavBucket[]} */
      const merged = [];
      for (let i = 0; i < navBucketList.length; i += 2) {
        const a = navBucketList[i];
        const b = navBucketList[i + 1];
        if (!b) {
          merged.push(a);
          break;
        }
        merged.push({
          x0: a.x0,
          x1: b.x1,
          min: Math.min(a.min, b.min),
          max: Math.max(a.max, b.max),
          n: a.n + b.n,
        });
      }
      navBucketList = merged;
      navPpb *= 2;
    }
  }
  navSrcLen++;
}

function flattenNavBuckets() {
  const n = navBucketList.length * 2;
  if (n === 0) {
    const empty = new Float64Array(0);
    navX = empty;
    navY = empty;
    return;
  }
  if (!navFlatX || !navFlatY || navFlatCap < n) {
    navFlatCap = Math.max(n, navFlatCap * 2 || 64);
    navFlatX = new Float64Array(navFlatCap);
    navFlatY = new Float64Array(navFlatCap);
  }
  let k = 0;
  for (const b of navBucketList) {
    navFlatX[k] = b.x0;
    navFlatX[k + 1] = b.x1;
    navFlatY[k] = b.min;
    navFlatY[k + 1] = b.max;
    k += 2;
  }
  navX = navFlatX.subarray(0, n);
  navY = navFlatY.subarray(0, n);
}

/** 把新样本折进导航桶；不 flatten、不 setData。 */
function syncNavBuckets() {
  const cs = state.chartSeries;
  const n = cs.x.length;
  const cap = navMaxBuckets();
  const xs = cs.x;
  const ps = cs.power;
  if (n <= cap) {
    if (navSrcLen > n) resetNavBuckets();
    return;
  }
  if (navSrcLen > n || navSrcLen === 0) {
    resetNavBuckets();
    foldNavRange(xs, ps, 0, n, cap);
  } else if (navSrcLen < n) {
    foldNavRange(xs, ps, navSrcLen, n, cap);
  }
}

/** @param {import('./state.js').F64Col} xs @param {import('./state.js').F64Col} ps @param {number} start @param {number} end @param {number} cap */
function foldNavRange(xs, ps, start, end, cap) {
  for (let i = start; i < end; ) {
    const xSpan = columnSpan(xs, i, end);
    const pSpan = columnSpan(ps, i, end);
    const through = Math.min(xSpan.end, pSpan.end);
    for (; i < through; i++)
      pushNavSample(Number(xSpan.values[i - xSpan.base]), Number(pSpan.values[i - pSpan.base]), cap);
  }
}

/** 把导航图数据指到短历史功率列，或宽度级 minmax 桶。 */
function bindNavData() {
  const cs = state.chartSeries;
  const n = cs.x.length;
  const cap = navMaxBuckets();
  syncNavBuckets();
  if (n <= cap) {
    navData = [cs.x.copyRange(0, n), cs.power.copyRange(0, n)];
    return;
  }
  flattenNavBuckets();
  navData = [navX, navY];
}

/**
 * spline 平滑仅在可见点数不超过该阈值时启用。
 * 密集视图下改用 uPlot 的 linear 构建器：它按像素列聚合（每列只画 min/max 竖线），
 * 视觉上与逐点绘制无差别（非数据降采样），可流畅支撑百万级点数。
 */
const SPLINE_MAX_POINTS = 1000;
/** @type {any} spline 路径构建器（替代 Chart.js 的 tension 平滑曲线，稀疏视图时启用） */
let splineBuilder = null;
/** @type {any} linear 路径构建器（密集视图，像素列聚合） */
let linearBuilder = null;

/**
 * 自适应路径构建：稀疏时 spline 平滑，密集时 linear 聚合。
 * @param {any} u @param {number} seriesIdx @param {number} idx0 @param {number} idx1
 */
function adaptivePaths(u, seriesIdx, idx0, idx1) {
  const builder =
    boundKind === 'raw' && splineBuilder && idx1 - idx0 <= SPLINE_MAX_POINTS
      ? splineBuilder
      : (linearBuilder ?? splineBuilder);
  return builder ? builder(u, seriesIdx, idx0, idx1) : null;
}

// ─── Data binding ────────────────────────────────────────────────────────────

/**
 * 将图表数据重新指向当前的 chartSeries 数组，并重置最大值跟踪。
 * 仅在序列数组被整体替换（清空、导入 CSV）后需要调用；
 * 追加数据点时数组引用不变，无需重新绑定。
 */
function bindMainViews(start, end) {
  const cs = state.chartSeries;
  rawStart = Math.max(0, start - 1);
  rawEnd = Math.min(cs.x.length, end + 1);
  mainData = [
    cs.x.copyRange(rawStart, rawEnd),
    cs.voltage.copyRange(rawStart, rawEnd),
    cs.current.copyRange(rawStart, rawEnd),
    cs.power.copyRange(rawStart, rawEnd),
    cs.temp.copyRange(rawStart, rawEnd),
    cs.dp.copyRange(rawStart, rawEnd),
    cs.dn.copyRange(rawStart, rawEnd),
    cs.cc1.copyRange(rawStart, rawEnd),
    cs.cc2.copyRange(rawStart, rawEnd),
  ];
}

export function syncChartSeries() {
  cancelPreparation();
  mainData = [[], [], [], [], [], [], [], [], []];
  rawStart = 0;
  rawEnd = 0;
  extremaIndex.reset();
  displayBuckets.reset(0);
  boundKind = 'raw';
  appliedMainGen = -1;
  appliedXRange = null;
  resetNavBuckets();
  seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
  seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
  scannedLen = 0;
  dataGen++;
  if (state.chartSeries.x.length <= COOPERATIVE_POINTS) {
    bindNavData();
    trackNewPoints();
  }
}

/** @param {boolean} dragging */
export function setRangeDragging(dragging) {
  rangeDragging = !!dragging;
  state.__rangeDragging = rangeDragging;
}

/**
 * 增量扫描新追加的数据点，维护每条曲线的全量 min/max。
 * @returns {boolean} 是否有任一通道极值变化（决定 setData 要不要重算 Y 轴）
 */
function trackNewPoints(through = state.chartSeries.x.length) {
  const cs = state.chartSeries;
  const len = Math.min(through, cs.x.length);
  if (len <= scannedLen) {
    scannedLen = len;
    return false;
  }
  const cols = [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
  let changed = false;
  for (let si = 0; si < cols.length; si++) {
    const arr = cols[si];
    let max = seriesMax[si + 1];
    let min = seriesMin[si + 1];
    for (const { values } of arr.chunks(scannedLen, len)) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) {
          if (v > max) {
            max = v;
            changed = true;
          }
          if (v < min) {
            min = v;
            changed = true;
          }
        }
      }
    }
    seriesMax[si + 1] = max;
    seriesMin[si + 1] = min;
  }
  scannedLen = len;
  return changed;
}

function sourceRange() {
  const xs = state.chartSeries.x;
  const n = xs.length;
  if (n === 0) return { start: 0, end: 0 };
  if (xWindow.min == null || xWindow.max == null) return { start: 0, end: n };
  const start = firstIndexAtOrAfter(xs, n, xWindow.min);
  let end = firstIndexAfter(xs, n, xWindow.max);
  if (end <= start) end = Math.min(n, start + 1);
  return { start, end };
}

/**
 * 绘图区 CSS 宽度，`bucketCap` 由它定条带密度。
 * `bbox.width` 是设备像素，而换算比在建图时就被烘进每张图 —— vendor 包里 dppx 监听只改静态
 * `uPlot.pxRatio`，没有 `setPxRatio`。拿静态值去除会在改系统缩放 / 换屏后得到一个既不是旧宽也不是
 * 新宽的宽度。后备宽 ÷ CSS 宽 才是渲染真正在用的比值：画布陈旧时它一起陈旧，条带密度就仍匹配正在显示的画面。
 */
function plotCssWidth() {
  const chart = state.mainChart;
  const bboxWidth = chart?.bbox?.width;
  if (bboxWidth) {
    const backing = chart.over?.width;
    const css = chart.width;
    if (backing && css && backing > 0 && css > 0) return bboxWidth / (backing / css);
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    return bboxWidth / (typeof uPlot !== 'undefined' ? uPlot.pxRatio || dpr : dpr);
  }
  return document.getElementById('main-chart')?.clientWidth || 600;
}

function channelBufs() {
  const cs = state.chartSeries;
  return [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
}

/** @param {SeriesBuckets} buckets @param {BoundKind} kind */
function bindFlattenedBuckets(buckets, kind) {
  const flat = buckets.flatten();
  mainData = [flat.x, ...flat.ys];
  boundKind = kind;
}

/**
 * 条带折叠的**速度选择器**：只决定耗时，不决定产出值 —— 金字塔 fold 与逐样本扫描对同一条带
 * 得到同一组 min/max（`test/chart-extrema.test.js` 的 `compare()` 逐桶钉着这条等价）。
 * 所以拖动中 / 松手后 / 冷启动走到不同分支，画出来的曲线也必须一模一样。
 * @param {import('./chart-buckets.js').NumericColumn[]} series @param {number} end @param {number} ppb
 * @returns {ExactExtremaIndex|null}
 */
function extremaForStripes(series, end, ppb) {
  // 条带不超过一个块时，fold 的 head/tail 暴力扫就等于整条，金字塔省不下读取。
  if (ppb <= BLOCK_SIZE) return null;
  // 窗口内已完成的块都建好了才算 warm；冷建是 O(全量) 的一次性开销，只留给足够密的窗口付。
  const warm = extremaIndex.blocks >= Math.floor(end / BLOCK_SIZE);
  if (!warm && ppb < COLD_BUILD_PPB) return null;
  extremaIndex.sync(series, end);
  return extremaIndex;
}

/**
 * Prepare full-history auxiliaries without falling back to a full raw scan in
 * the requesting frame. Appends do not invalidate the fixed prefix in progress.
 * @param {number} length @param {number} end @param {number} ppb
 */
function prepareLargeHistory(length, end, ppb) {
  if (historyWork) return true;
  const cap = navMaxBuckets();
  const needIndex = ppb >= COLD_BUILD_PPB && end - extremaIndex.blocks * BLOCK_SIZE > COOPERATIVE_POINTS;
  if (
    length - scannedLen <= COOPERATIVE_POINTS &&
    (length <= cap || length - navSrcLen <= COOPERATIVE_POINTS) &&
    !needIndex
  )
    return false;
  const work = { generation: dataGen, cancelled: false };
  historyWork = work;
  const cs = state.chartSeries;
  const series = channelBufs();
  setPreparing(true);
  void runCooperativeSlices(
    () => {
      if (scannedLen < length) {
        trackNewPoints(Math.min(length, scannedLen + 4096));
        return false;
      }
      if (length > cap && navSrcLen < length) {
        const through = Math.min(length, navSrcLen + 4096);
        foldNavRange(cs.x, cs.power, navSrcLen, through, cap);
        return false;
      }
      return !needIndex || extremaIndex.syncStep(series, end);
    },
    { isCancelled: () => work.cancelled || work.generation !== dataGen },
  )
    .then((complete) => {
      if (historyWork !== work) return;
      historyWork = null;
      setPreparing(false);
      if (complete) updateCharts();
    })
    .catch((error) => {
      if (historyWork === work) {
        historyWork = null;
        setPreparing(false);
      }
      console.error('Chart history preparation failed', error);
    });
  return true;
}

/** @param {number} start @param {number} end @param {number} cap */
function prepareLargeProjection(start, end, cap) {
  const count = end - start;
  const ppb = stripePpb(count, cap);
  if (projectionWork && (projectionWork.start !== start || projectionWork.end !== end || projectionWork.cap !== cap)) {
    projectionWork.cancelled = true;
    projectionWork = null;
  }
  if (projectionWork) return true;
  if (count <= COOPERATIVE_POINTS || stripesMatch(start, end, count, cap)) return false;
  // A short append still uses the existing cheap incremental path.
  if (ppb === displayBuckets.ppb && displayBuckets.canAppend(start, end) && end - displayBuckets.srcEnd <= 4096)
    return false;
  const cs = state.chartSeries;
  const series = channelBufs();
  const index = extremaForStripes(series, end, ppb);
  const buckets = new SeriesBuckets();
  const step = buckets.beginRebuild(cs.x, series, start, end, cap, index);
  const work = { generation: dataGen, start, end, cap, cancelled: false };
  projectionWork = work;
  setPreparing(true);
  void runCooperativeSlices(() => step(index ? Math.max(4096, ppb * 16) : 4096), {
    isCancelled: () => work.cancelled || work.generation !== dataGen,
  })
    .then((complete) => {
      if (projectionWork !== work) return;
      projectionWork = null;
      setPreparing(false);
      const latest = sourceRange();
      if (complete && latest.start === start && latest.end === end && bucketCap(plotCssWidth()) === cap) {
        displayBuckets = buckets;
        bindFlattenedBuckets(displayBuckets, 'window');
        appliedMainGen = -1;
      }
      if (complete) updateCharts();
    })
    .catch((error) => {
      if (projectionWork === work) {
        projectionWork = null;
        setPreparing(false);
      }
      console.error('Chart projection preparation failed', error);
    });
  return true;
}

/**
 * 现有条带是否正好是窗口 `(start,end)` 在该密度下应当画出的那批（不含绑定状态）。
 * 密度也是判据：复用的前提是先缩放进来、松手后重建会算出同一批条带。
 * @param {number} start @param {number} end @param {number} windowCount @param {number} cap
 */
function stripesMatch(start, end, windowCount, cap) {
  return (
    displayBuckets.ppb === stripePpb(windowCount, cap) &&
    displayBuckets.srcStart === start &&
    displayBuckets.srcEnd === end &&
    displayBuckets.list.length > 0
  );
}

/**
 * 当前绑定的顶点是否已经就是本窗口该画的那批，因而只需 setScale。
 * @param {number} start @param {number} end @param {number} windowCount @param {number} cap
 */
function bindingCovers(start, end, windowCount, cap) {
  if (windowCount <= cap) {
    // Keep both neighbours: uPlot needs their segments at clipped boundaries.
    return (
      boundKind === 'raw' &&
      rawStart <= Math.max(0, start - 1) &&
      rawEnd >= Math.min(state.chartSeries.x.length, end + 1)
    );
  }
  return boundKind === 'window' && stripesMatch(start, end, windowCount, cap);
}

function applyXScale() {
  if (!state.mainChart) return;
  const [min, max] = xRange();
  state.mainChart.setScale('x', { min, max });
}

/**
 * 「画什么」的唯一定义：把主图绑到窗口 `[start,end)` 在 `stripePpb(windowCount, cap)` 密度下的
 * min/max 条带；窗口不超过 1×绘图宽度时复制原始样本及裁剪邻点。拖动中与松手后都只经过这里。
 * @param {{ cap: number, start: number, end: number, windowCount: number, force: boolean }} args
 */
function bindDisplayData(args) {
  const { cap, start, end, windowCount, force } = args;
  const cs = state.chartSeries;

  if (windowCount <= cap) {
    boundKind = 'raw';
    bindMainViews(start, end);
    return;
  }

  const ppb = stripePpb(windowCount, cap);
  const series = channelBufs();

  if (stripesMatch(start, end, windowCount, cap)) {
    if (boundKind !== 'window') bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  // 左边界与密度都没动、只是窗口向右延长：追加比整表重扫便宜得多（流式跟随常用）。
  if (!force && ppb === displayBuckets.ppb && displayBuckets.canAppend(start, end)) {
    displayBuckets.appendThrough(cs.x, series, end);
    bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  displayBuckets.rebuild(cs.x, series, start, end, cap, extremaForStripes(series, end, ppb));
  bindFlattenedBuckets(displayBuckets, 'window');
}

function requestPaint() {
  if (paintRequest == null) {
    paintRequest = { batchId: ++paintBatchId, requestedAt: performance.now(), prepareMs: null };
  }
  return paintRequest;
}

/** @param {any} chart @param {PaintRequest} request */
function expectChartDraw(chart, request) {
  if (!chart) return;
  const pending = pendingDraws.get(chart);
  if (pending?.last === request) return;
  pendingDraws.set(chart, { first: pending?.first ?? request, last: request, count: (pending?.count ?? 0) + 1 });
}

/**
 * uPlot 的 setData/setScale 通常在微任务中合并绘制；draw 才是实际绘制终点。
 * 这里只报告请求到 draw 的延迟（含排队 / 准备），不是 draw 执行耗时。
 * 绘制执行耗时不单列：终点 hook 拿不到 uPlot 那次绘制的起点，它本来就在合并后的 requestToDrawMs 里。
 * @param {any} chart
 */
function finishChartDraw(chart) {
  const pending = pendingDraws.get(chart);
  if (!pending) return;
  const drawEndedAt = performance.now();
  pendingDraws.delete(chart);
  chart.__chartPaintTiming = {
    firstBatchId: pending.first.batchId,
    batchId: pending.last.batchId,
    coalescedRequests: pending.count,
    requestedAt: pending.first.requestedAt,
    drawEndedAt,
    requestToDrawMs: drawEndedAt - pending.first.requestedAt,
    prepareMs: pending.last.prepareMs,
  };
}

/** 同步准备耗时仅作诊断，不据此猜测 GPU / Canvas 耗时或固定降帧。
 * @param {number} t0 @param {PaintRequest} request
 */
function finishPreparation(t0, request) {
  request.prepareMs = performance.now() - t0;
}

/**
 * 将当前数据应用到两个图表（范围由各 scale 的 range 函数自动计算）。
 * @param {{ force?: boolean }} [opts]
 */
function applyData(opts = {}) {
  if (!monitorVisible()) {
    chartDirty = true;
    return;
  }

  const request = requestPaint();
  paintRequest = null;
  const t0 = performance.now();
  chartDirty = false;
  const srcLen = state.chartSeries.x.length;
  const { start, end } = sourceRange();
  const cap = bucketCap(plotCssWidth());
  const windowCount = end - start;
  if (prepareLargeHistory(srcLen, end, stripePpb(windowCount, cap)) || prepareLargeProjection(start, end, cap)) {
    chartDirty = true;
    // Keep the original request timestamp across slices so draw latency includes
    // deferred preparation instead of starting over when its result is ready.
    paintRequest = request;
    finishPreparation(t0, request);
    return;
  }
  const appended = srcLen > scannedLen;
  const yChanged = trackNewPoints();
  const force = !!opts.force;
  const dataChanged = appended || appliedMainGen !== dataGen;
  // 拖动中唯一被推迟的是导航图重扫：它与主图画什么无关。
  const preview = rangeDragging && !force;

  const nextXRange = xRange();
  const sameXRange = appliedXRange?.[0] === nextXRange[0] && appliedXRange?.[1] === nextXRange[1];
  const covers = bindingCovers(start, end, windowCount, cap);
  const frozenAppend = appended && state.chartWindow.mode === 'frozen' && sameXRange && covers && !yChanged;
  const reuseBinding = !force && appliedMainGen === dataGen && covers && (!dataChanged || frozenAppend);

  if (reuseBinding) {
    if (!sameXRange) {
      expectChartDraw(state.mainChart, request);
      applyXScale();
    }
  } else {
    bindDisplayData({ cap, start, end, windowCount, force });
    if (state.mainChart) {
      expectChartDraw(state.mainChart, request);
      // Y 量程来自全量 seriesMax，与是否分桶无关；极值未破时跳过四轴量化。
      if (appended && !yChanged && xWindow.min != null && xWindow.max != null && !force) {
        state.mainChart.setData(/** @type {any} */ (mainData), false);
        applyXScale();
      } else {
        state.mainChart.setData(/** @type {any} */ (mainData));
      }
    }
  }
  appliedXRange = nextXRange;

  if (dataChanged || appliedNavGen !== dataGen || appliedNavLen !== srcLen) {
    syncNavBuckets();
    const nav = state.navigatorChart;
    const now = performance.now();
    const cap = navMaxBuckets();
    const live = state.isRecording && !force && !preview && srcLen > cap;
    const due = !live || now - lastNavPaint >= NAV_PAINT_MIN_MS || appliedNavGen !== dataGen;
    if (nav && due && (appliedNavGen !== dataGen || appliedNavLen !== srcLen)) {
      bindNavData();
      expectChartDraw(nav, request);
      nav.setData(/** @type {any} */ (navData));
      appliedNavGen = dataGen;
      appliedNavLen = srcLen;
      lastNavPaint = now;
    }
  }

  appliedMainGen = dataGen;
  finishPreparation(t0, request);
}

/** 立即刷新两个图表；隐藏时只打脏标记，不提交绘制。 */
export function updateCharts() {
  cancelChartFrame();
  flushChart(true);
}

/**
 * 显示设置（纵向余量等）变化后刷新两图量程。
 * dataGen++ 迫使 applyData 对导航图重发 setData：它的 gen/length 快路径
 * 否则会跳过重建，把旧余量留在缩略图上。
 */
export function refreshChartScales() {
  dataGen++;
  chartDirty = true;
  cancelChartFrame();
  flushChart();
}

/** 恢复可见性时把尺寸补偿、积累的数据和已有请求合到同一帧。 */
export function handleMonitorShown() {
  resizeDirty = true;
  scheduleChartUpdate();
}

function cancelChartFrame() {
  displayFrames.cancel('chart');
  chartFramePending = false;
  state.__chartUpdatePending = false;
}

function registerChartListeners() {
  if (chartListenersRegistered) return;
  chartListenersRegistered = true;
  onThemeChange(applyChartTheme);
  document.addEventListener('visibilitychange', () => {
    if (!monitorVisible()) {
      chartDirty = true;
      paintRequest = null;
      cancelChartFrame();
      return;
    }
    handleMonitorShown();
  });
}

/** @param {boolean} [force=false] */
function flushChart(force = false) {
  if (!monitorVisible()) {
    chartDirty = true;
    paintRequest = null;
    return;
  }
  flushingChart = true;
  try {
    flushResizes();
    if (divisionSyncPending) {
      divisionSyncPending = false;
      dataGen++;
      chartDirty = true;
    }
    if (chartDirty || force || forceResizePaint) applyData({ force: force || forceResizePaint });
    forceResizePaint = false;
  } finally {
    flushingChart = false;
    paintRequest = null;
  }
}

/** 使用 requestAnimationFrame 合帧；后台数据照收，图表只记 dirty。 */
export function scheduleChartUpdate() {
  chartDirty = true;
  if (!monitorVisible() || flushingChart) return;
  requestPaint();
  if (chartFramePending) return;
  chartFramePending = true;
  state.__chartUpdatePending = true;
  displayFrames.schedule(
    'chart',
    () => {
      chartFramePending = false;
      state.__chartUpdatePending = false;
      flushChart();
    },
    10,
  );
}

// ─── Range / visibility / fill ───────────────────────────────────────────────

/**
 * 设置主图 X 轴可见窗口（由范围滑块驱动）。调用后需触发一次刷新才会生效。
 * 传入 null 可清除窗口（恢复为跟随数据范围 / 默认范围）。
 * @param {number|null} min
 * @param {number|null} max
 */
export function setChartXWindow(min, max) {
  xWindow.min = min;
  xWindow.max = max;
}

/**
 * 显示 / 隐藏指定曲线。对应的 Y 轴会自动跟随显隐（scale 无可见序列时返回空量程）。
 * @param {number} datasetIndex - 0=电压 1=电流 2=功率 3=温度 4=D+ 5=D- 6=CC1 7=CC2
 * @param {boolean} show
 */
export function setSeriesVisible(datasetIndex, show) {
  const chart = state.mainChart;
  const si = datasetIndex + 1;
  if (!chart || !chart.series[si]) return;
  chart.setSeries(si, { show: !!show });
  renderLegend();
}

/**
 * 设置指定曲线的填充不透明度。
 * @param {number} datasetIndex - 0=电压 1=电流 2=功率 3=温度
 * @param {number} opacityPercent - 0-100，0 表示关闭填充
 */
export function setSeriesFill(datasetIndex, opacityPercent) {
  const field = FIELDS[datasetIndex];
  if (!field) return;
  fillStyles[datasetIndex + 1] =
    opacityPercent > 0 ? hexToRgba(/** @type {any} */ (chartTheme)[field], opacityPercent) : null;
  if (state.mainChart) state.mainChart.redraw();
}

/**
 * 主题令牌变化后重新应用图表配色。
 * 曲线 / 轴 / 网格的 stroke 均为读取 chartTheme 的闭包，redraw 即可拾取新值；
 * 只有填充色是预计算的 rgba 字符串，需要按当前设置重算。
 */
export function applyChartTheme() {
  const s = state.settings;
  fillStyles = [
    null,
    s.opacityVoltage > 0 ? hexToRgba(chartTheme.voltage, s.opacityVoltage) : null,
    s.opacityCurrent > 0 ? hexToRgba(chartTheme.current, s.opacityCurrent) : null,
    s.opacityPower > 0 ? hexToRgba(chartTheme.power, s.opacityPower) : null,
    s.opacityTemp > 0 ? hexToRgba(chartTheme.temp, s.opacityTemp) : null,
    null,
    null,
    null,
    null,
  ];
  state.mainChart?.redraw();
  state.navigatorChart?.redraw();
  renderLegend();
}

// ─── Scale ranges ────────────────────────────────────────────────────────────

/**
 * 主图 X 轴范围：优先使用滑块窗口，否则与数据齐平（不加人为留白）；无数据时给一个默认时间窗。
 * 数据范围直接读模块内的序列数组（uPlot 传入的 dataMin/dataMax 在退化情况下会被其内部逻辑预填充，不可靠）。
 * @returns {[number, number]}
 */
function xRange() {
  let min;
  let max;
  if (xWindow.min != null && xWindow.max != null) {
    min = xWindow.min;
    max = xWindow.max;
  } else {
    const xs = state.chartSeries.x;
    if (!xs.length) return [0, 60];
    min = Number(xs.at(0));
    max = Number(xs.at(-1));
  }
  // 单点 / 零跨度保护（uPlot 不接受 min == max）
  if (!(max - min > 0)) return [min - 0.3, min + 0.3];
  return [min, max];
}

/**
 * 挂靠在电压 scale 上的 series 下标集合。
 * D+/D-/CC1/CC2 叠加曲线与电压共用一个 scale：量程必须聚合所有挂靠曲线，
 * 否则隐藏电压时叠加曲线会失去量程（mkYRange 旧实现只看电压一条）。
 */
const VOLTAGE_SCALE_SERIES = [1, 5, 6, 7, 8];

/**
 * 图表纵向余量（0-1 小数）。auto = 25%（曲线保持中高位置），custom 读设置值。
 * @returns {number}
 */
function headroomFrac() {
  const s = state.settings;
  if (s.chartHeadroomMode === 'custom') {
    const p = Number(s.chartHeadroomPercent);
    if (Number.isFinite(p)) return Math.min(100, Math.max(0, p)) / 100;
  }
  return 0.25;
}

/**
 * 聚合一组挂靠在同一 scale 上的可见 series 的全量 min/max。
 * @param {any} u @param {number[]} seriesIndexes
 * @returns {{min: number, max: number}|{empty: true}|null} 全部隐藏 → null（轴自动隐藏）；可见但无有限数据 → {empty:true}
 */
function aggregateVisible(u, seriesIndexes) {
  let anyVisible = false;
  let max = -Infinity;
  let min = Infinity;
  for (const si of seriesIndexes) {
    if (!u.series[si] || !u.series[si].show) continue;
    anyVisible = true;
    if (Number.isFinite(seriesMax[si]) && seriesMax[si] > max) max = seriesMax[si];
    if (Number.isFinite(seriesMin[si]) && seriesMin[si] < min) min = seriesMin[si];
  }
  if (!anyVisible) return null;
  if (!Number.isFinite(max)) return { empty: true };
  return { min, max };
}

/**
 * 0 基线 + 顶部余量；出现负值时（有符号电流）底部按同比例外扩。
 * @param {number} min @param {number} max @param {number} h
 * @returns {[number, number]}
 */
function paddedZeroBased(min, max, h) {
  const lo = min < 0 ? min * (1 + h) : 0;
  const hi = max > 0 ? max * (1 + h) : min < 0 ? 0 : 1;
  return lo < hi ? [lo, hi] : [lo - 0.5, hi + 0.5];
}

/** 挂在纵轴上的全部 scale（网格 / 等分对齐的作用域）。 */
const Y_SCALES = ['voltage', 'current', 'power', 'temp'];

/**
 * 全部 Y 轴共用的等分格数。
 *
 * 多轴网格对齐的关键：对齐不要求各轴数值相同，只要求刻度落在相同的高度比例上。
 * 于是取一个全局等分数 N，把每条轴的量程量化成 N 个整齐步长（quantizeRange），
 * 刻度用 min + (max-min)·i/N 生成（uniformSplits）—— 第 i 条刻度在每条轴上都是
 * 同一像素行，四条轴的网格线因此严格重合。
 *
 * 用 u.height（画布总高）而非 u.bbox.height 推算：bbox 依赖轴宽、轴宽依赖刻度
 * 文字、刻度又依赖等分数，读 bbox 会形成布局循环。70 是 X 轴 + 轴顶横向标题
 * 的大致占用，余下按约 80px/格换算——只随窗口尺寸变化，不随数据抖动。
 * @param {any} u
 * @returns {number}
 */
function yDivisions(u) {
  const plotHeight = Math.max(80, (Number(u?.height) || 300) - 70);
  return Math.min(7, Math.max(3, Math.round(plotHeight / 80)));
}

/**
 * 量程量化时实际采用的等分数。
 *
 * 刻度（uniformSplits）与次网格必须复用它，而不是各自再调一次 yDivisions：
 * 量程只在 setData / setScale 时重算，而 yDivisions 随窗口高度即时变化，
 * 两者若不同步就会出现「按 7 等分量化的量程被切成 5 份」——刻度落在 5.6、11.2
 * 这种非整数上。窗口高度变化后由 syncDivisionsAfterResize 补一次量程重算。
 */
let appliedYDivisions = 0;

/** 绘图区高度变了 → 等分数可能变，与尺寸 / 数据提交共用一帧。 */
let divisionSyncPending = false;
function syncDivisionsAfterResize(/** @type {any} */ u) {
  if (divisionSyncPending || yDivisions(u) === appliedYDivisions) return;
  divisionSyncPending = true;
  scheduleChartUpdate();
}

/** 量化步长的候选尾数。比常见的 1/2/5 更细，用于压低量化引入的额外余量。 */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/**
 * 把量程量化为「整齐步长 × 等分数」，使刻度既是整数值又正好铺满绘图区。
 *
 * 代价：量化只向上取整，实际纵向余量可能比设置值多出至多一个步长（细候选表把
 * 超出压在 20% 上下，粗糙的 1/2/5 阶梯会翻倍）。这是「整齐刻度 + 严格对齐」不可
 * 避免的开销。
 * @param {number} lo @param {number} hi @param {number} divisions
 * @returns {[number, number]}
 */
function quantizeRange(lo, hi, divisions) {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [lo, hi];
  const mag = 10 ** Math.floor(Math.log10(span / divisions));
  // 起点下取整最多把跨度撑大一个步长，因此候选需覆盖到 span/(divisions-1)；
  // divisions ≥ 3 时该值 < 1.5×原始步长，两个数量级的候选表足够。
  for (const decade of [mag, mag * 10]) {
    for (const step of NICE_STEPS) {
      const incr = step * decade;
      const start = Math.floor(lo / incr + 1e-9) * incr;
      if (start + incr * divisions >= hi - Math.abs(hi) * 1e-9) return [start, start + incr * divisions];
    }
  }
  return [lo, hi];
}

/**
 * 构造 Y 轴范围函数：聚合挂靠该 scale 的所有可见 series，0 起点 + 可配置余量，
 * 最后量化到全局等分格（与其余 Y 轴共线）。
 * 注意：量程完全来自模块内的 seriesMax/seriesMin 增量跟踪，因此各 series 均设置
 * auto: false，跳过 uPlot 每次提交时对全量数据的 min/max 扫描（百万级点数下显著提速）。
 * @param {number[]} seriesIndexes - 挂靠在该 scale 上的 series 下标
 * @param {boolean} [symmetric=false] - 温度轴：对称余量，保留负值
 */
function mkYRange(seriesIndexes, symmetric = false) {
  return /** @type {any} */ (
    /** @param {any} u */
    (u) => {
      const agg = aggregateVisible(u, seriesIndexes);
      const divisions = yDivisions(u);
      appliedYDivisions = divisions;
      if (agg === null) return [null, null];
      if ('empty' in agg) return quantizeRange(0, 1, divisions);
      const h = headroomFrac();
      let lo;
      let hi;
      if (symmetric) {
        const span = agg.max - agg.min;
        const padding = span > 0 ? span * h : 1;
        lo = agg.min - padding;
        hi = agg.max + padding;
      } else {
        [lo, hi] = paddedZeroBased(agg.min, agg.max, h);
      }
      return quantizeRange(lo, hi, divisions);
    }
  );
}

// ─── Axis helpers ────────────────────────────────────────────────────────────

/**
 * 智能小数位刻度格式化（与旧版 Chart.js 回调一致）。
 * @param {number} value
 * @returns {string}
 */
function smartTick(value) {
  const absVal = Math.abs(value);
  if (absVal > 0 && absVal < 0.001) return String(parseFloat(value.toFixed(6)));
  if (absVal > 0 && absVal < 0.1) return String(parseFloat(value.toFixed(5)));
  if (absVal > 0 && absVal < 1) return String(parseFloat(value.toFixed(4)));
  return String(parseFloat(value.toFixed(3)));
}

/**
 * 生成与其余 Y 轴共线的等分刻度（配合 quantizeRange 量化后的整齐量程使用）。
 * 用 min + (max-min)·i/N 而非逐格累加步长：与 drawMinorGrid 的几何算式同源，
 * 浮点结果逐位一致，刻度线与网格线不会差半个像素。
 * @param {any} u @param {string} scaleKey
 * @returns {number[]}
 */
function uniformSplits(u, scaleKey) {
  const scale = u.scales?.[scaleKey];
  if (scale?.min == null || scale?.max == null) return [];
  const min = Number(scale.min);
  const span = Number(scale.max) - min;
  const n = appliedYDivisions || yDivisions(u);
  return Array.from({ length: n + 1 }, (_, i) => min + (span * i) / n);
}

/**
 * Y 轴宽度自适应：按最长刻度文字实测宽度分配，避免小数位多时被裁剪。
 * @param {any} u @param {string[]|null} values @param {number} axisIdx @param {number} cycleNum
 * @returns {number}
 */
function axisAutoSize(u, values, axisIdx, cycleNum) {
  const axis = u.axes[axisIdx];
  // 第二轮布局迭代后直接复用已计算的尺寸，避免布局震荡
  if (cycleNum > 1) return axis._size;
  let size = (axis.ticks?.show ? axis.ticks.size : 0) + axis.gap + 4;
  const longest = (values ?? []).reduce((acc, v) => (String(v).length > acc.length ? String(v) : acc), '');
  if (longest !== '') {
    u.ctx.font = axis.font[0];
    size += u.ctx.measureText(longest).width / (uPlot.pxRatio || devicePixelRatio || 1);
  }
  return Math.ceil(Math.max(size, 28));
}

/**
 * 轴顶横向标题占用的上边距（CSS px）。
 * 顶刻度数字相对绘图区顶边居中，大约伸出 6px；再加标题行高与缝隙。
 * 取代 uPlot 默认 ~17px 顶垫，避免标题与顶刻度挤在一起。
 */
const Y_AXIS_LABEL_PAD = 24;

/**
 * 构造一条 Y 轴配置。
 * 颜色参数为读取 chartTheme 的闭包（uPlot 对 stroke 支持函数形式），换主题后 redraw 即生效。
 * 标题不走 uPlot 的 `label`（只能竖排贴在轴侧并额外占 labelSize），改由 drawYAxisLabels 画在轴顶。
 * @param {string} scaleKey
 * @param {string} label
 * @param {() => string} color
 * @param {number} side - 3=左 1=右
 * @returns {any}
 */
function mkYAxis(scaleKey, label, color, side) {
  return {
    scale: scaleKey,
    side,
    stroke: color,
    axisTitle: label,
    labelFont: `12px ${CHART_FONT}`,
    font: `12px ${MONO_FONT}`,
    // 数字与竖脊之间的空隙；默认朝数字伸出的 ticks 已关闭（见 drawYAxisChrome）
    gap: 6,
    size: axisAutoSize,
    // 等分刻度由 uniformSplits 决定，uPlot 基于 space / incrs 的自动选点被完全覆盖
    splits: (/** @type {any} */ u) => uniformSplits(u, scaleKey),
    values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map(smartTick),
    // 四条 Y 轴画同一套主网格：量程已量化到相同的高度比例，像素级重合；
    // 令牌是不透明色，重复描边不会叠亮（见 tokens.css 的说明）
    grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
    // 关掉 uPlot 朝数字伸出的横刻度：右侧会像负号。竖脊 + 朝图内的短刻度由 drawYAxisChrome 画
    ticks: { show: false },
  };
}

// ─── Minor grid ──────────────────────────────────────────────────────────────

/** 是否至少有一条 Y 轴在显示（挂靠曲线全部隐藏时该 scale 的 min 为 null）。 */
function hasVisibleYScale(/** @type {any} */ u) {
  return Y_SCALES.some((key) => u.scales?.[key]?.min != null);
}

/**
 * 在主刻度之间画次网格：每个主格均分成 5 格（4 条次线）。
 *
 * 纵向次线取自 X 轴实际刻度（时间步长非等距，只能读 _splits）；
 * 横向次线按几何等分推出——全部 Y 轴共用 yDivisions 等分，次线与任一条轴的刻度
 * 都对齐，因此不依赖某条具体的轴，隐藏电压曲线后横向次网格依然在位。
 * @param {any} u
 */
function drawMinorGrid(u) {
  const { ctx, bbox } = u;
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;

  const left = bbox.left;
  const right = bbox.left + bbox.width;
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
  // 主刻度间距低于此值时不再插次线，避免窄图上重新糊成一片（设备像素）
  const minGapPx = 36 * pxRatio;
  const minorCells = 5;

  ctx.save();
  ctx.lineWidth = pxRatio;
  ctx.strokeStyle = chartTheme.gridMinor;
  // 与 uPlot 画网格线同款的清晰化手法：奇数线宽整体平移半像素
  const offset = (ctx.lineWidth % 2) / 2;
  ctx.translate(offset, offset);
  ctx.beginPath();

  // ── 纵向次线（X 轴主刻度之间） ──
  const xSplits = u.axes?.[0]?._splits;
  if (Array.isArray(xSplits) && xSplits.length >= 2) {
    for (let i = 0; i < xSplits.length - 1; i++) {
      const a = u.valToPos(xSplits[i], 'x', true);
      const b = u.valToPos(xSplits[i + 1], 'x', true);
      if (Math.abs(b - a) < minGapPx) continue;
      for (let k = 1; k < minorCells; k++) {
        const x = Math.round(a + ((b - a) * k) / minorCells);
        if (x >= left && x <= right) {
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
        }
      }
    }
  }

  // ── 横向次线（Y 轴等分格之间） ──
  const divisions = appliedYDivisions || yDivisions(u);
  if (bbox.height / divisions >= minGapPx && hasVisibleYScale(u)) {
    for (let i = 0; i < divisions; i++) {
      for (let k = 1; k < minorCells; k++) {
        const y = Math.round(top + (bbox.height * (i + k / minorCells)) / divisions);
        if (y >= top && y <= bottom) {
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
        }
      }
    }
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * 传统坐标轴形态：每条可见 Y 轴一条通道色竖脊；贴着绘图区边缘的轴再朝图内画短刻度。
 * 刻度在竖脊朝图一侧（右侧是 `┤ 1` 而不是 `── 1`），不会被看成负号。
 * 外侧轴（同一侧第二条）脊在轴沟里，短刻度若朝图会戳到内侧轴标题，故只画脊。
 * @param {any} u
 */
function drawYAxisChrome(u) {
  const { ctx, bbox } = u;
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;

  const left = bbox.left;
  const right = bbox.left + bbox.width;
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
  const tickLen = 5 * pxRatio;
  const edgeEps = pxRatio * 1.5;

  ctx.save();
  ctx.lineWidth = pxRatio;
  ctx.lineCap = 'butt';
  const offset = (ctx.lineWidth % 2) / 2;
  ctx.translate(offset, offset);

  const axes = u.axes ?? [];
  for (let i = 1; i < axes.length; i++) {
    const axis = axes[i];
    if (!axis?.show || axis._show === false || axis._pos == null) continue;
    if (u.scales?.[axis.scale]?.min == null) continue;

    const x = Math.round(axis._pos * pxRatio);
    const stroke = typeof axis.stroke === 'function' ? axis.stroke(u, i) : axis.stroke;
    if (!stroke) continue;

    ctx.strokeStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);

    // side 3=左 → 刻度向右进图；side 1=右 → 刻度向左进图
    const inward = axis.side === 3 ? 1 : axis.side === 1 ? -1 : 0;
    const atPlotEdge =
      inward === 1 ? Math.abs(x - left) <= edgeEps : inward === -1 ? Math.abs(x - right) <= edgeEps : false;
    if (atPlotEdge && Array.isArray(axis._splits)) {
      for (const v of axis._splits) {
        const y = Math.round(u.valToPos(v, axis.scale, true));
        if (y < top || y > bottom) continue;
        ctx.moveTo(x, y);
        ctx.lineTo(x + inward * tickLen, y);
      }
    }
    ctx.stroke();
  }

  ctx.strokeStyle = chartTheme.grid;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  ctx.restore();
}

/**
 * 在每条可见 Y 轴顶部画横向标题。
 * 轴沟只有约 30px，标题宽约 50px，居中于列会和邻居叠字。
 * 贴着绘图区的轴：标题从竖脊朝图内伸出；外侧轴：贴画布外沿。
 * @param {any} u
 */
function drawYAxisLabels(u) {
  const { ctx, bbox } = u;
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;

  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
  const axes = u.axes ?? [];
  const canvasW = ctx.canvas.width;
  const left = bbox.left;
  const right = bbox.left + bbox.width;
  const gap = 4 * pxRatio;
  const y = bbox.top - 8 * pxRatio;
  const edgeEps = pxRatio * 1.5;

  ctx.save();
  ctx.textBaseline = 'bottom';

  for (let i = 1; i < axes.length; i++) {
    const axis = axes[i];
    if (!axis?.show || axis._show === false || axis._pos == null) continue;
    if (u.scales?.[axis.scale]?.min == null) continue;
    const title = axis.axisTitle;
    if (!title) continue;

    const stroke = typeof axis.stroke === 'function' ? axis.stroke(u, i) : axis.stroke;
    if (!stroke) continue;

    const pos = axis._pos * pxRatio;
    const atLeftEdge = axis.side === 3 && Math.abs(pos - left) <= edgeEps;
    const atRightEdge = axis.side === 1 && Math.abs(pos - right) <= edgeEps;

    let x = pos;
    /** @type {CanvasTextAlign} */
    let align = 'center';
    if (axis.side === 3) {
      align = 'left';
      x = atLeftEdge ? pos + gap : gap;
    } else if (axis.side === 1) {
      align = 'right';
      x = atRightEdge ? pos - gap : canvasW - gap;
    }

    ctx.font = Array.isArray(axis.labelFont) ? axis.labelFont[0] : `12px ${CHART_FONT}`;
    ctx.fillStyle = stroke;
    ctx.textAlign = align;
    ctx.fillText(title, x, y);
  }

  ctx.restore();
}

// ─── Legend ──────────────────────────────────────────────────────────────────

/** 渲染顶部图例（仅列出当前可见的曲线，与旧版 generateLabels 过滤逻辑一致）。 */
function renderLegend() {
  const el = document.getElementById('main-chart-legend');
  const chart = state.mainChart;
  if (!el || !chart) return;

  const fragment = document.createDocumentFragment();
  for (let si = 1; si < chart.series.length; si++) {
    if (!chart.series[si].show) continue;
    const item = document.createElement('span');
    item.className = 'chart-legend-item';
    const dot = document.createElement('span');
    dot.className = 'chart-legend-dot';
    dot.style.background = /** @type {any} */ (chartTheme)[FIELDS[si - 1]];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(LABELS[si - 1]));
    fragment.appendChild(item);
  }
  el.replaceChildren(fragment);
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

/**
 * 缺测在 Float64Array 里只能是 NaN，uPlot 只把 == null 当缺口。
 * NaN 会让 valToPos 得到 NaN，光标点 transform 无效，钉在绘图区左上角。
 * 返回 null 让 uPlot 把该 series 的 hover 点移出视口。
 * @param {any} u
 * @param {number} seriesIdx
 * @param {number|null} hoveredIdx
 * @returns {number|null}
 */
/**
 * 桶显示时 uPlot 的 idx 是顶点下标，用 X 二分回全量列。
 * @param {any} u
 * @param {number|null} hoveredIdx
 * @returns {number|null}
 */
function realIndexFromCursor(u, hoveredIdx) {
  if (hoveredIdx == null || appliedMainGen !== dataGen) return null;
  const left = u.cursor.left;
  if (!Number.isFinite(left) || left < 0) return null;
  const xVal = u.posToVal(left, 'x');
  if (!Number.isFinite(xVal) || state.chartSeries.x.length === 0) return null;
  return nearestIndex(state.chartSeries.x, state.chartSeries.x.length, xVal);
}

/** Position hover markers on the same raw sample used by the tooltip.
 * @param {any} u @param {number} seriesIdx
 */
function cursorPointBox(u, seriesIdx) {
  const index = realIndexFromCursor(u, u.cursor.idx);
  const field = /** @type {keyof typeof state.chartSeries} */ (FIELDS[seriesIdx - 1]);
  const value = index == null ? Number.NaN : state.chartSeries[field].valueAt(index);
  if (index == null || !Number.isFinite(value)) return { left: -100, top: -100, width: 0, height: 0 };
  return {
    left: u.valToPos(state.chartSeries.x.valueAt(index), 'x') - 4,
    top: u.valToPos(value, SERIES_SCALES[seriesIdx - 1]) - 4,
    width: 8,
    height: 8,
  };
}

function cursorDataIdx(u, seriesIdx, hoveredIdx) {
  if (hoveredIdx == null) return null;
  const realIdx = realIndexFromCursor(u, hoveredIdx);
  if (realIdx == null) return null;
  if (seriesIdx === 0) return hoveredIdx;
  const field = FIELDS[seriesIdx - 1];
  const y = state.chartSeries[/** @type {keyof typeof state.chartSeries} */ (field)]?.valueAt(realIdx);
  return Number.isFinite(y) ? hoveredIdx : null;
}

/**
 * 悬停 tooltip 插件：index 模式（显示最近 X 处所有可见曲线的值），
 * 标题为相对时间，各行带颜色标记与单位，贴近旧版 Chart.js tooltip 样式。
 * @returns {any}
 */
function tooltipPlugin() {
  /** @type {HTMLDivElement|null} */
  let tt = null;
  /** @type {HTMLDivElement|null} */
  let title = null;
  /** @type {{ row: HTMLDivElement, swatch: HTMLSpanElement, text: Text }[]} */
  const rows = [];
  /** @type {number|null} */
  let frame = null;
  /** @type {ResizeObserver|null} */
  let observer = null;
  let lastIndex = -1;
  let lastGen = -1;
  let lastMask = -1;
  let lastTheme = -1;
  let visibleRows = 0;
  let shown = false;
  let sizeDirty = true;
  let overDirty = true;
  let width = 0;
  let height = 0;
  let overWidth = 0;
  let overHeight = 0;
  /** @type {(() => void)|null} */
  let invalidate = null;

  function hide() {
    if (shown && tt) tt.style.display = 'none';
    shown = false;
  }

  /** @param {any} u */
  function commit(u) {
    if (!tt || !title || !monitorVisible()) return;
    const { idx, left, top } = u.cursor;
    if (idx == null || left == null || left < 0 || top == null || top < 0) {
      hide();
      return;
    }
    // 从指针时间查原始点；不使用桶中点，否则同一桶内移动会吸附到错误样本。
    const realIdx = realIndexFromCursor(u, idx);
    const xVal = realIdx == null ? null : state.chartSeries.x.valueAt(realIdx);
    if (realIdx == null || xVal == null || !Number.isFinite(xVal)) {
      hide();
      return;
    }
    let mask = 0;
    for (let i = 0; i < FIELDS.length; i++) {
      if (u.series[i + 1]?.show) mask |= 1 << i;
    }
    if (realIdx !== lastIndex || dataGen !== lastGen || mask !== lastMask || tooltipThemeGen !== lastTheme) {
      const heading = formatRelativeHMS(Number(xVal));
      if (title.textContent !== heading) title.textContent = heading;
      visibleRows = 0;
      for (let i = 0; i < rows.length; i++) {
        const { row, swatch, text } = rows[i];
        const field = /** @type {keyof typeof state.chartSeries} */ (FIELDS[i]);
        const value = state.chartSeries[field]?.valueAt(realIdx);
        const show = !!(mask & (1 << i)) && Number.isFinite(value);
        const display = show ? '' : 'none';
        if (row.style.display !== display) row.style.display = display;
        if (show) {
          const label = `${LABELS[i]}: ${Number(value).toFixed(3)}${UNITS[i]}`;
          if (text.nodeValue !== label) text.nodeValue = label;
          visibleRows++;
        }
        if (lastTheme !== tooltipThemeGen) swatch.style.background = /** @type {any} */ (chartTheme)[FIELDS[i]];
      }
      lastIndex = realIdx;
      lastGen = dataGen;
      lastMask = mask;
      lastTheme = tooltipThemeGen;
      sizeDirty = true;
    }
    if (visibleRows === 0) {
      hide();
      return;
    }
    if (!shown) {
      tt.style.display = 'block';
      shown = true;
      sizeDirty = true;
      overDirty = true;
    }
    // 只在内容 / 显隐 / 主题 / 字体 / 尺寸变化后读几何；纯移动只写 transform。
    if (overDirty) {
      overWidth = u.over.clientWidth;
      overHeight = u.over.clientHeight;
      overDirty = false;
    }
    if (sizeDirty) {
      width = tt.offsetWidth;
      height = tt.offsetHeight;
      sizeDirty = false;
    }
    let x = left + 12;
    if (x + width > overWidth) x = left - width - 12;
    let y = top + 12;
    if (y + height > overHeight) y = top - height - 12;
    const transform = `translate(${Math.max(0, Math.round(x))}px, ${Math.max(0, Math.round(y))}px)`;
    if (tt.style.transform !== transform) tt.style.transform = transform;
  }

  /** @param {any} u */
  function schedule(u) {
    if (!tt || frame != null || !monitorVisible()) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      commit(u);
    });
  }

  return {
    hooks: {
      init: (/** @type {any} */ u) => {
        tt = document.createElement('div');
        tt.className = 'chart-tooltip';
        tt.style.display = 'none';
        title = document.createElement('div');
        title.className = 'chart-tooltip-title';
        tt.appendChild(title);
        for (let i = 0; i < FIELDS.length; i++) {
          const row = document.createElement('div');
          row.className = 'chart-tooltip-row';
          const swatch = document.createElement('span');
          swatch.className = 'chart-tooltip-swatch';
          const text = document.createTextNode('');
          row.appendChild(swatch);
          row.appendChild(text);
          tt.appendChild(row);
          rows.push({ row, swatch, text });
        }
        u.over.appendChild(tt);
        invalidate = () => {
          sizeDirty = true;
          overDirty = true;
          schedule(u);
        };
        observer = new ResizeObserver(invalidate);
        observer.observe(u.over);
        observer.observe(tt);
        document.fonts?.addEventListener('loadingdone', invalidate);
      },
      setCursor: schedule,
      setData: schedule,
      setSeries: schedule,
      draw: schedule,
      setSize: () => invalidate?.(),
      destroy: () => {
        if (frame != null) cancelAnimationFrame(frame);
        frame = null;
        observer?.disconnect();
        if (invalidate) document.fonts?.removeEventListener('loadingdone', invalidate);
        tt?.remove();
        tt = null;
        title = null;
        rows.length = 0;
      },
    },
  };
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

/**
 * 绘图区滚轮横向缩放。预览走手柄快路径，松手后补一帧全质量图。
 * @param {any} u
 */
function bindChartWheel(u) {
  const over = u?.over;
  if (!over) return;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let wheelEndTimer = null;
  over.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (state.chartSeries.x.length === 0) return;
      const rect = over.getBoundingClientRect();
      const pivot = u.posToVal(event.clientX - rect.left, 'x');
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
      setRangeDragging(true);
      state.__applyChartXZoom?.(pivot, factor);
      if (wheelEndTimer != null) clearTimeout(wheelEndTimer);
      wheelEndTimer = setTimeout(() => {
        wheelEndTimer = null;
        setRangeDragging(false);
        updateCharts();
      }, 80);
    },
    { passive: false },
  );
}

let resizeDirty = false;
let forceResizePaint = false;
/** @type {Map<any, { host: HTMLElement, onSize: (() => void)|null }>} */
const resizeTargets = new Map();

function flushResizes() {
  if (!resizeDirty || state.__layoutResizing) return;
  resizeDirty = false;
  // 先集中读取，再写 setSize，避免两张图交替读写布局。
  const sizes = [];
  for (const [chart, { host, onSize }] of resizeTargets) {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0 && (chart.width !== width || chart.height !== height)) {
      sizes.push({ chart, width, height, onSize });
    }
  }
  for (const { chart, width, height, onSize } of sizes) {
    expectChartDraw(chart, requestPaint());
    chart.setSize({ width, height });
    onSize?.();
    forceResizePaint = true;
  }
}

/**
 * ResizeObserver 只标脏，尺寸与流式刷新在同一 rAF 提交。
 * @param {HTMLElement} host
 * @param {any} chart
 * @param {(() => void)|null} [onSize]
 */
function observeResize(host, chart, onSize = null) {
  if (resizeTargets.has(chart)) return;
  resizeTargets.set(chart, { host, onSize });
  chart.hooks.draw ??= [];
  chart.hooks.draw.push(finishChartDraw);
  const ro = new ResizeObserver(() => {
    resizeDirty = true;
    chartDirty = true;
    if (!state.__layoutResizing) scheduleChartUpdate();
  });
  ro.observe(host);
  chart.hooks.destroy ??= [];
  chart.hooks.destroy.push(() => {
    ro.disconnect();
    resizeTargets.delete(chart);
    pendingDraws.delete(chart);
  });
}

// ─── Chart initialization ────────────────────────────────────────────────────

/** 初始化主图表。 */
export function initChart() {
  const host = document.getElementById('main-chart');
  if (!host) return;

  syncChartFonts();
  syncChartSeries();

  splineBuilder = uPlot.paths?.spline ? uPlot.paths.spline() : null;
  linearBuilder = uPlot.paths?.linear ? uPlot.paths.linear() : null;
  const hasPaths = splineBuilder != null || linearBuilder != null;

  const s = state.settings;
  fillStyles = [
    null,
    s.opacityVoltage > 0 ? hexToRgba(chartTheme.voltage, s.opacityVoltage) : null,
    s.opacityCurrent > 0 ? hexToRgba(chartTheme.current, s.opacityCurrent) : null,
    s.opacityPower > 0 ? hexToRgba(chartTheme.power, s.opacityPower) : null,
    s.opacityTemp > 0 ? hexToRgba(chartTheme.temp, s.opacityTemp) : null,
    null,
    null,
    null,
    null,
  ];

  const showInitial = [
    s.showVoltage,
    s.showCurrent,
    s.showPower,
    s.showTemp && (state.isTempConnected || state.hasTempData),
    s.showDpDn,
    s.showDpDn,
    s.showCc,
    s.showCc,
  ];

  const opts = {
    width: host.clientWidth || 600,
    height: host.clientHeight || 300,
    ms: 1,
    pxAlign: 1,
    legend: { show: false },
    // 顶边留给横向轴标题；左右/底仍走 uPlot 按轴自动垫
    padding: /** @type {any} */ ([Y_AXIS_LABEL_PAD, null, null, null]),
    cursor: {
      y: false,
      drag: { setScale: false, x: false, y: false },
      points: { size: 8, bbox: cursorPointBox },
      dataIdx: cursorDataIdx,
    },
    scales: {
      x: { time: false, range: /** @type {any} */ (xRange) },
      voltage: { range: mkYRange(VOLTAGE_SCALE_SERIES) },
      current: { range: mkYRange([2]) },
      power: { range: mkYRange([3]) },
      temp: { range: mkYRange([4], true) },
    },
    series: [
      {},
      ...FIELDS.map((field, i) => ({
        label: LABELS[i],
        scale: SERIES_SCALES[i],
        auto: false,
        stroke: () => /** @type {any} */ (chartTheme)[field],
        // D+/D-/CC 叠加曲线更细，避免与主通道曲线抢焦点
        width: i >= 4 ? 1 : 1.5,
        points: { show: false },
        ...(hasPaths ? { paths: adaptivePaths } : {}),
        fill: () => fillStyles[i + 1],
        show: showInitial[i],
      })),
    ],
    axes: [
      {
        scale: 'x',
        stroke: () => chartTheme.axisText,
        font: `12px ${MONO_FONT}`,
        size: 34,
        gap: 4,
        // 80：HH:MM:SS.d 标签约 10 字符（等宽 12px ≈ 72px），64 会在任意宽度下互相碰撞
        space: 80,
        incrs: TIME_INCRS,
        values: (/** @type {any} */ _u, /** @type {number[]} */ splits) =>
          splits.map((v) => formatRelativeHMS(Number(v))),
        grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
        ticks: { show: true, stroke: () => chartTheme.grid, width: 1, size: 8 },
      },
      mkYAxis('voltage', '电压 (V)', () => chartTheme.voltage, 3),
      mkYAxis('current', '电流 (A)', () => chartTheme.current, 3),
      mkYAxis('power', '功率 (W)', () => chartTheme.power, 1),
      mkYAxis('temp', '温度 (°C)', () => chartTheme.tempAxis, 1),
    ],
    hooks: {
      drawAxes: [drawMinorGrid, drawYAxisChrome, drawYAxisLabels],
      setSize: [syncDivisionsAfterResize],
    },
    plugins: [tooltipPlugin()],
  };

  state.mainChart = new uPlot(opts, /** @type {any} */ (mainData), host);
  bindChartWheel(state.mainChart);
  observeResize(host, state.mainChart, () => {
    displayBuckets.reset(0);
  });
  renderLegend();
  registerChartListeners();

  initNavigatorChart();

  // Canvas 不解析 CSS var()；与令牌对齐后再 load 一次，避免首帧用了回退栈。系统字体通常立刻 resolve。
  if (document.fonts?.load) {
    Promise.all([document.fonts.load(`12px ${CHART_FONT}`), document.fonts.load(`12px ${MONO_FONT}`)])
      .then(() => {
        state.mainChart?.redraw();
        state.navigatorChart?.redraw();
      })
      .catch(() => {});
  }
}

/** 初始化导航器图表（功率全量缩略图，无轴无交互）。 */
function initNavigatorChart() {
  const host = document.getElementById('navigator-chart');
  if (!host) return;

  const opts = {
    width: host.clientWidth || 600,
    height: host.clientHeight || 46,
    ms: 1,
    pxAlign: 1,
    padding: /** @type {[number, number, number, number]} */ ([2, 0, 2, 0]),
    legend: { show: false },
    cursor: { show: false },
    scales: {
      x: {
        time: false,
        // 与数据齐平，不加人为留白；直接读序列数组（uPlot 传参在退化情况下不可靠）
        range: /** @type {any} */ (
          () => {
            const xs = navData[0];
            if (!xs.length) return [0, 60];
            const min = xs[0];
            const max = xs[xs.length - 1];
            if (!(max - min > 0)) return [min - 0.3, max + 0.3];
            return [min, max];
          }
        ),
      },
      y: {
        // 量程来自模块内跟踪的功率全量最大值（序列 auto: false，跳过 uPlot 的全量扫描）
        range: /** @type {any} */ (
          () => {
            const max = seriesMax[3];
            return [0, Number.isFinite(max) && max > 0 ? max * (1 + headroomFrac()) : 1];
          }
        ),
      },
    },
    series: [
      {},
      {
        scale: 'y',
        auto: false,
        stroke: () => chartTheme.power,
        width: 1,
        points: { show: false },
        ...(splineBuilder != null || linearBuilder != null ? { paths: adaptivePaths } : {}),
      },
    ],
    axes: [{ show: false }, { show: false }],
  };

  state.navigatorChart = new uPlot(opts, /** @type {any} */ (navData), host);
  observeResize(host, state.navigatorChart, () => {
    resetNavBuckets();
    appliedNavGen = -1;
  });
}
