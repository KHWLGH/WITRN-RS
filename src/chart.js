// @ts-check
/**
 * @file uPlot 图表初始化、渲染调度、交互（tooltip / 图例 / X 轴窗口）。
 *
 * uPlot 由 vendor/uPlot.iife.min.js 以全局变量方式载入（本地文件，无网络依赖）。
 * 数据为列式（columnar）格式：state.chartSeries = { x, voltage, current, power, temp, dp, dn, cc1, cc2 }，
 * 主图绑定 F64Col.view()（[x, v, c, p, t, dp, dn, cc1, cc2]），追加后在 applyData 里换新视图再 setData。
 *
 * 对外 API：
 * - initChart()           初始化主图 + 导航图
 * - scheduleChartUpdate() rAF 节流刷新（流式追加数据用）
 * - updateCharts()        立即刷新
 * - syncChartSeries()     序列数组被整体替换（清空 / 导入 CSV）后重新绑定
 * 可见窗口超过 2×绘图宽度时 setData 送增量 min/max 桶，全量仍在 chartSeries。
 * 拖动导航条只改 X 窗（setScale）；松手后再按窗口单遍重建显示桶。
 * - setChartXWindow()     设置主图 X 轴可见窗口（范围滑块）
 * - setRangeDragging()    手柄拖动期间走窗口快路径，推迟窗口级重建
 * - setSeriesVisible()    显示 / 隐藏某条曲线（对应 Y 轴自动跟随显隐）
 * - setSeriesFill()       设置某条曲线的填充不透明度（0 = 关闭填充）
 */

import { bucketCap, firstIndexAfter, firstIndexAtOrAfter, nearestIndex, SeriesBuckets } from './chart-buckets.js';
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

/** 主图数据（列式）：[x, voltage, current, power, temp, dp, dn, cc1, cc2]，元素为 F64Col.view()。 */
/** @typedef {number[]|Float64Array} ChartColView */
/** @type {ChartColView[]} */
let mainData = [[], [], [], [], [], [], [], [], []];
/** 导航图数据：[x, power]（全量视图或桶数组）。 */
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

/** 主图窗口级显示桶：可见窗口点数超过 2×宽度后启用，存储仍走全量列。 */
const displayBuckets = new SeriesBuckets();
/** 全历史概览桶：不随 X 窗口重置，拖动扩大窗口时作 O(宽度) 兜底。 */
const overviewBuckets = new SeriesBuckets();
let usingDisplayBuckets = false;
/** @typedef {'raw'|'window'|'overview'} BoundKind */
/** @type {BoundKind} */
let boundKind = 'raw';
/** 范围手柄是否正在拖动（只改 X 窗，不重建窗口级桶）。 */
let rangeDragging = false;
/** 上次完整 apply 时的数据代数 / 绘图宽度桶上限。 */
let appliedMainGen = -1;
let appliedCap = -1;

/** 数据代数 — 序列数组被整体替换（清空 / 导入）时递增，用于跳过导航图不必要的重建。 */
let dataGen = 0;
/** 导航图最近一次 setData 时的代数与长度；仅数据变化时才重建导航图（X 窗口拖动不触碰它）。 */
let appliedNavGen = -1;
let appliedNavLen = -1;

/** 上一帧绘制超过该预算则暂缓下一张图，数据照收。点数少时绘制远低于此值，行为与逐点刷新相同。 */
const PAINT_BUDGET_MS = 10;
let skipUntil = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let skipWakeTimer = null;
let chartDirty = false;

function monitorVisible() {
  return state.settings.activeView === 'monitor';
}

/**
 * 导航图 minmax 桶。点数不超过 2×宽度时直接引用全量列；超过后按桶聚合，
 * 新点只更新最后一桶，桶数超上限则两两合并。
 * @typedef {{ x0: number, x1: number, min: number, max: number, n: number }} NavBucket
 */
/** @type {NavBucket[]} */
let navBucketList = [];
let navPpb = 1;
let navSrcLen = 0;
/** @type {number[]} */
let navX = [];
/** @type {number[]} */
let navY = [];

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

/** @param {number} x @param {number} p */
function pushNavSample(x, p) {
  const v = Number.isFinite(p) ? p : 0;
  const last = navBucketList[navBucketList.length - 1];
  if (last && last.n < navPpb) {
    last.x1 = x;
    if (v < last.min) last.min = v;
    if (v > last.max) last.max = v;
    last.n++;
  } else {
    navBucketList.push({ x0: x, x1: x, min: v, max: v, n: 1 });
    const cap = navMaxBuckets();
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
  navX = [];
  navY = [];
  for (const b of navBucketList) {
    navX.push(b.x0, b.x1);
    navY.push(b.min, b.max);
  }
}

/** 把导航图数据指到全量功率列，或宽度级 minmax 桶。 */
function bindNavData() {
  const cs = state.chartSeries;
  const n = cs.x.length;
  const cap = navMaxBuckets();
  const xs = cs.x.buf;
  const ps = cs.power.buf;
  if (n <= cap) {
    navData = [cs.x.view(), cs.power.view()];
    if (navSrcLen > n) resetNavBuckets();
    return;
  }
  if (navSrcLen > n || navSrcLen === 0) {
    resetNavBuckets();
    for (let i = 0; i < n; i++) pushNavSample(xs[i], ps[i]);
  } else if (navSrcLen < n) {
    for (let i = navSrcLen; i < n; i++) pushNavSample(xs[i], ps[i]);
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
  const builder = splineBuilder && idx1 - idx0 <= SPLINE_MAX_POINTS ? splineBuilder : (linearBuilder ?? splineBuilder);
  return builder ? builder(u, seriesIdx, idx0, idx1) : null;
}

// ─── Data binding ────────────────────────────────────────────────────────────

/**
 * 将图表数据重新指向当前的 chartSeries 数组，并重置最大值跟踪。
 * 仅在序列数组被整体替换（清空、导入 CSV）后需要调用；
 * 追加数据点时数组引用不变，无需重新绑定。
 */
function bindMainViews() {
  const cs = state.chartSeries;
  mainData = [
    cs.x.view(),
    cs.voltage.view(),
    cs.current.view(),
    cs.power.view(),
    cs.temp.view(),
    cs.dp.view(),
    cs.dn.view(),
    cs.cc1.view(),
    cs.cc2.view(),
  ];
}

export function syncChartSeries() {
  bindMainViews();
  displayBuckets.reset(0);
  overviewBuckets.reset(0);
  usingDisplayBuckets = false;
  boundKind = 'raw';
  appliedMainGen = -1;
  appliedCap = -1;
  resetNavBuckets();
  bindNavData();
  seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
  seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
  scannedLen = 0;
  dataGen++;
  trackNewPoints();
}

/** @param {boolean} dragging */
export function setRangeDragging(dragging) {
  rangeDragging = !!dragging;
}

/**
 * 增量扫描新追加的数据点，维护每条曲线的全量 min/max。
 * @returns {boolean} 是否有任一通道极值变化（决定 setData 要不要重算 Y 轴）
 */
function trackNewPoints() {
  const cs = state.chartSeries;
  const len = cs.x.length;
  if (len <= scannedLen) {
    scannedLen = len;
    return false;
  }
  const cols = [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
  let changed = false;
  for (let si = 0; si < cols.length; si++) {
    const arr = cols[si].buf;
    let max = seriesMax[si + 1];
    let min = seriesMin[si + 1];
    for (let i = scannedLen; i < len; i++) {
      const v = arr[i];
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
  const start = firstIndexAtOrAfter(xs.buf, n, xWindow.min);
  let end = firstIndexAfter(xs.buf, n, xWindow.max);
  if (end <= start) end = Math.min(n, start + 1);
  return { start, end };
}

function plotCssWidth() {
  const chart = state.mainChart;
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const pxRatio = typeof uPlot !== 'undefined' ? uPlot.pxRatio || dpr : dpr;
  if (chart?.bbox?.width) return chart.bbox.width / pxRatio;
  return document.getElementById('main-chart')?.clientWidth || 600;
}

function channelBufs() {
  const cs = state.chartSeries;
  return [cs.voltage.buf, cs.current.buf, cs.power.buf, cs.temp.buf, cs.dp.buf, cs.dn.buf, cs.cc1.buf, cs.cc2.buf];
}

/** @param {SeriesBuckets} buckets @param {BoundKind} kind */
function bindFlattenedBuckets(buckets, kind) {
  const flat = buckets.flatten();
  mainData = [flat.x, ...flat.ys];
  boundKind = kind;
  usingDisplayBuckets = true;
}

/** @param {number} cap */
function syncOverviewBuckets(cap) {
  const cs = state.chartSeries;
  const n = cs.x.length;
  const series = channelBufs();
  if (n === 0) {
    overviewBuckets.reset(0);
    overviewBuckets.cap = cap;
    return;
  }
  if (overviewBuckets.cap !== cap || overviewBuckets.srcStart !== 0 || overviewBuckets.srcEnd > n) {
    overviewBuckets.rebuild(cs.x.buf, series, 0, n, cap);
    return;
  }
  if (overviewBuckets.srcEnd < n) {
    overviewBuckets.appendThrough(cs.x.buf, series, n);
  }
}

/**
 * 当前绑定的顶点是否覆盖新窗口，因而只需 setScale。
 * @param {number} start @param {number} end @param {number} windowCount @param {number} cap
 */
function bindingCovers(start, end, windowCount, cap) {
  if (windowCount <= cap) return boundKind === 'raw' && !usingDisplayBuckets;
  if (boundKind === 'raw' || !usingDisplayBuckets) return false;
  if (boundKind === 'overview') return overviewBuckets.covers(start, end) && overviewBuckets.cap === cap;
  return displayBuckets.covers(start, end) && displayBuckets.cap === cap;
}

function applyXScale() {
  if (!state.mainChart) return;
  const [min, max] = xRange();
  state.mainChart.setScale('x', { min, max });
}

/**
 * 可见窗口超过 2×宽度时改送像素桶；否则继续零拷贝全量视图。
 * 缩进时不扔掉已有窗口桶，扩大时由调用方改绑概览桶。
 * @param {{ cap: number, start: number, end: number, windowCount: number, force: boolean }} args
 */
function bindDisplayData(args) {
  const { cap, start, end, windowCount, force } = args;
  const cs = state.chartSeries;
  syncOverviewBuckets(cap);

  if (windowCount <= cap) {
    usingDisplayBuckets = false;
    boundKind = 'raw';
    bindMainViews();
    return;
  }

  const series = channelBufs();
  const exact =
    displayBuckets.cap === cap &&
    displayBuckets.srcStart === start &&
    displayBuckets.srcEnd === end &&
    displayBuckets.list.length > 0;

  if (exact) {
    if (boundKind !== 'window') bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  if (
    !force &&
    displayBuckets.canAppend(start, end) &&
    displayBuckets.cap === cap &&
    displayBuckets.srcEnd > displayBuckets.srcStart
  ) {
    displayBuckets.appendThrough(cs.x.buf, series, end);
    bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  displayBuckets.rebuild(cs.x.buf, series, start, end, cap);
  bindFlattenedBuckets(displayBuckets, 'window');
}

function clearPaintSkip() {
  skipUntil = 0;
  if (skipWakeTimer != null) {
    clearTimeout(skipWakeTimer);
    skipWakeTimer = null;
  }
}

/** @param {number} t0 @param {boolean} preview */
function finishPaint(t0, preview) {
  const dt = performance.now() - t0;
  // 拖动预览必须跟手；其余路径预算耗尽最多让一帧。
  skipUntil = !preview && dt > PAINT_BUDGET_MS ? performance.now() + Math.min(dt, 16) : 0;
  chartDirty = false;
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

  const t0 = performance.now();
  const srcLen = state.chartSeries.x.length;
  const appended = srcLen > scannedLen;
  const yChanged = trackNewPoints();
  const force = !!opts.force;
  const dataChanged = appended || appliedMainGen !== dataGen;
  const { start, end } = sourceRange();
  const cap = bucketCap(plotCssWidth());
  const windowCount = end - start;
  const preview = rangeDragging && !force;

  if (!dataChanged && !force && appliedCap === cap && bindingCovers(start, end, windowCount, cap)) {
    applyXScale();
    finishPaint(t0, preview);
    return;
  }

  if (preview && windowCount > cap) {
    syncOverviewBuckets(cap);
    if (bindingCovers(start, end, windowCount, cap)) {
      applyXScale();
      finishPaint(t0, true);
      return;
    }
    bindFlattenedBuckets(overviewBuckets, 'overview');
    if (state.mainChart) {
      state.mainChart.setData(/** @type {any} */ (mainData), false);
      applyXScale();
    }
    appliedCap = cap;
    finishPaint(t0, true);
    return;
  }

  bindDisplayData({ cap, start, end, windowCount, force });
  if (state.mainChart) {
    // 仅全量视图上流式追加且 Y 极值未破时跳过四轴量化；桶显示每帧顶点会变。
    if (!usingDisplayBuckets && appended && !yChanged && xWindow.min != null && xWindow.max != null && !force) {
      state.mainChart.setData(/** @type {any} */ (mainData), false);
      applyXScale();
    } else {
      state.mainChart.setData(/** @type {any} */ (mainData));
    }
  }

  if (dataChanged || appliedNavGen !== dataGen || appliedNavLen !== srcLen) {
    bindNavData();
    const nav = state.navigatorChart;
    if (nav && (appliedNavGen !== dataGen || appliedNavLen !== srcLen)) {
      nav.setData(/** @type {any} */ (navData));
      appliedNavGen = dataGen;
      appliedNavLen = srcLen;
    }
  }

  appliedMainGen = dataGen;
  appliedCap = cap;
  finishPaint(t0, preview);
}

/** 立即刷新两个图表（忽略绘制预算，隐藏时只打脏标记）。 */
export function updateCharts() {
  clearPaintSkip();
  applyData({ force: true });
}

/**
 * 显示设置（纵向余量等）变化后刷新两图量程。
 * dataGen++ 迫使 applyData 对导航图重发 setData：它的 gen/length 快路径
 * 否则会跳过重建，把旧余量留在缩略图上。
 */
export function refreshChartScales() {
  dataGen++;
  applyData();
}

/**
 * 监控视图重新显示时的尺寸补偿。
 * 监控 hidden 时仍保几何，通常不必 setSize；宽高真变了才对齐。
 * 隐藏期间跳过的绘制用 chartDirty 补一帧，不再无条件 updateCharts。
 */
export function handleMonitorShown() {
  /** @param {string} hostId @param {any} chart */
  const fit = (hostId, chart) => {
    const host = document.getElementById(hostId);
    if (!host || !chart) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (chart.width === width && chart.height === height) return;
    chart.setSize({ width, height });
  };
  fit('main-chart', state.mainChart);
  fit('navigator-chart', state.navigatorChart);
  if (chartDirty) {
    clearPaintSkip();
    applyData();
  }
}

function flushChart() {
  if (!monitorVisible()) {
    chartDirty = true;
    return;
  }
  const now = performance.now();
  if (!rangeDragging && now < skipUntil) {
    chartDirty = true;
    if (skipWakeTimer == null) {
      skipWakeTimer = setTimeout(
        () => {
          skipWakeTimer = null;
          scheduleChartUpdate();
        },
        Math.max(0, Math.ceil(skipUntil - performance.now())),
      );
    }
    return;
  }
  applyData();
}

/** 使用 requestAnimationFrame 调度图表更新，避免每个数据点都触发重绘。 */
export function scheduleChartUpdate() {
  if (state.__chartUpdatePending) return;
  state.__chartUpdatePending = true;
  requestAnimationFrame(() => {
    state.__chartUpdatePending = false;
    flushChart();
  });
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
    min = xs.at(0);
    max = xs.at(-1);
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

/** 绘图区高度变了 → 等分数可能变，安排一次量程重算，让刻度值回到整齐步长。 */
let divisionSyncPending = false;
function syncDivisionsAfterResize(/** @type {any} */ u) {
  if (divisionSyncPending || yDivisions(u) === appliedYDivisions) return;
  divisionSyncPending = true;
  requestAnimationFrame(() => {
    divisionSyncPending = false;
    refreshChartScales();
  });
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
 * 在主刻度之间各画一条中线，形成主 / 次两级网格。
 *
 * 纵向中线取自 X 轴实际刻度（时间步长非等距，只能读 _splits）；
 * 横向中线按几何等分推出——全部 Y 轴共用 yDivisions 等分，中线与任一条轴的刻度
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
  // 主刻度间距低于此值时不再插中线，避免窄图上重新糊成一片（设备像素）
  const minGapPx = 36 * pxRatio;

  ctx.save();
  ctx.lineWidth = pxRatio;
  ctx.strokeStyle = chartTheme.gridMinor;
  // 与 uPlot 画网格线同款的清晰化手法：奇数线宽整体平移半像素
  const offset = (ctx.lineWidth % 2) / 2;
  ctx.translate(offset, offset);
  ctx.beginPath();

  // ── 纵向中线（X 轴主刻度之间） ──
  const xSplits = u.axes?.[0]?._splits;
  if (Array.isArray(xSplits) && xSplits.length >= 2) {
    for (let i = 0; i < xSplits.length - 1; i++) {
      const a = u.valToPos(xSplits[i], 'x', true);
      const b = u.valToPos(xSplits[i + 1], 'x', true);
      if (Math.abs(b - a) < minGapPx) continue;
      const x = Math.round((a + b) / 2);
      if (x >= left && x <= right) {
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
      }
    }
  }

  // ── 横向中线（Y 轴等分格之间） ──
  const divisions = appliedYDivisions || yDivisions(u);
  if (bbox.height / divisions >= minGapPx && hasVisibleYScale(u)) {
    for (let i = 0; i < divisions; i++) {
      const y = Math.round(top + (bbox.height * (i + 0.5)) / divisions);
      if (y >= top && y <= bottom) {
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
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
  if (hoveredIdx == null) return null;
  const xVal = u.data[0]?.[hoveredIdx];
  if (xVal == null || !Number.isFinite(xVal)) return null;
  if (!usingDisplayBuckets) return hoveredIdx;
  return nearestIndex(state.chartSeries.x.buf, state.chartSeries.x.length, Number(xVal));
}

function cursorDataIdx(u, seriesIdx, hoveredIdx) {
  if (hoveredIdx == null) return null;
  const realIdx = realIndexFromCursor(u, hoveredIdx);
  if (realIdx == null) return null;
  if (seriesIdx === 0) return hoveredIdx;
  const field = FIELDS[seriesIdx - 1];
  const y = state.chartSeries[/** @type {keyof typeof state.chartSeries} */ (field)]?.buf[realIdx];
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

  return {
    hooks: {
      init: (/** @type {any} */ u) => {
        tt = document.createElement('div');
        tt.className = 'chart-tooltip';
        tt.style.display = 'none';
        u.over.appendChild(tt);
      },
      setCursor: (/** @type {any} */ u) => {
        if (!tt) return;
        const { idx, left, top } = u.cursor;
        if (idx == null || left == null || left < 0 || top == null || top < 0) {
          tt.style.display = 'none';
          return;
        }
        const realIdx = realIndexFromCursor(u, idx);
        if (realIdx == null) {
          tt.style.display = 'none';
          return;
        }
        const xVal = state.chartSeries.x.buf[realIdx];
        if (xVal == null || !Number.isFinite(xVal)) {
          tt.style.display = 'none';
          return;
        }

        const fragment = document.createDocumentFragment();
        const title = document.createElement('div');
        title.className = 'chart-tooltip-title';
        title.textContent = formatRelativeHMS(Number(xVal));
        fragment.appendChild(title);

        let rows = 0;
        for (let si = 1; si < u.series.length; si++) {
          if (!u.series[si].show) continue;
          const field = FIELDS[si - 1];
          const yVal = state.chartSeries[/** @type {keyof typeof state.chartSeries} */ (field)]?.buf[realIdx];
          if (yVal == null || !Number.isFinite(yVal)) continue;
          const row = document.createElement('div');
          row.className = 'chart-tooltip-row';
          const swatch = document.createElement('span');
          swatch.className = 'chart-tooltip-swatch';
          swatch.style.background = /** @type {any} */ (chartTheme)[FIELDS[si - 1]];
          row.appendChild(swatch);
          row.appendChild(document.createTextNode(`${LABELS[si - 1]}: ${Number(yVal).toFixed(3)}${UNITS[si - 1]}`));
          fragment.appendChild(row);
          rows++;
        }
        if (rows === 0) {
          tt.style.display = 'none';
          return;
        }

        tt.replaceChildren(fragment);
        tt.style.display = 'block';

        // 跟随光标，靠近边缘时翻转到另一侧
        const overW = u.over.clientWidth;
        const overH = u.over.clientHeight;
        let x = left + 12;
        if (x + tt.offsetWidth > overW) x = left - tt.offsetWidth - 12;
        let y = top + 12;
        if (y + tt.offsetHeight > overH) y = top - tt.offsetHeight - 12;
        tt.style.transform = `translate(${Math.max(0, Math.round(x))}px, ${Math.max(0, Math.round(y))}px)`;
      },
    },
  };
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

/**
 * 监听宿主元素尺寸变化并同步图表大小。
 * @param {HTMLElement} host
 * @param {any} chart
 */
/**
 * @param {HTMLElement} host
 * @param {any} chart
 * @param {(() => void)|null} [onSize]
 */
function observeResize(host, chart, onSize = null) {
  const ro = new ResizeObserver(() => {
    if (!monitorVisible()) {
      chartDirty = true;
      return;
    }
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0) {
      if (chart.width !== width || chart.height !== height) {
        chart.setSize({ width, height });
        onSize?.();
      }
    }
  });
  ro.observe(host);
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
      points: { size: 8 },
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
  observeResize(host, state.mainChart, () => {
    displayBuckets.reset(0);
    applyData({ force: true });
  });
  renderLegend();
  onThemeChange(applyChartTheme);

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
export function initNavigatorChart() {
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
    bindNavData();
    appliedNavGen = -1;
    if (state.navigatorChart) state.navigatorChart.setData(/** @type {any} */ (navData));
    appliedNavGen = dataGen;
    appliedNavLen = state.chartSeries.x.length;
  });
}
