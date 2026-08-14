// @ts-check
/**
 * @file uPlot 图表初始化、渲染调度、交互（tooltip / 图例 / X 轴窗口）。
 *
 * uPlot 由 vendor/uPlot.iife.min.js 以全局变量方式载入（本地文件，无网络依赖）。
 * 数据为列式（columnar）格式：state.chartSeries = { x, voltage, current, power, temp, dp, dn, cc1, cc2 }，
 * 主图直接引用这些数组（[x, v, c, p, t, dp, dn, cc1, cc2]），追加数据后调用 setData 即可刷新。
 *
 * 对外 API：
 * - initChart()           初始化主图 + 导航图
 * - scheduleChartUpdate() rAF 节流刷新（流式追加数据用）
 * - updateCharts()        立即刷新
 * - syncChartSeries()     序列数组被整体替换（清空 / 导入 CSV）后重新绑定
 * - setChartXWindow()     设置主图 X 轴可见窗口（范围滑块）
 * - setSeriesVisible()    显示 / 隐藏某条曲线（对应 Y 轴自动跟随显隐）
 * - setSeriesFill()       设置某条曲线的填充不透明度（0 = 关闭填充）
 */

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
  "'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif";
const MONO_FONT_FALLBACK = "'Maple Mono NF CN', 'Cascadia Mono', 'Consolas', monospace";
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

/** 主图数据（列式）：[x, voltage, current, power, temp, dp, dn, cc1, cc2]，元素直接引用 state.chartSeries 的数组。 */
/** @type {number[][]} */
let mainData = [[], [], [], [], [], [], [], [], []];
/** 导航图数据：[x, power]。 */
/** @type {number[][]} */
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

/** 数据代数 — 序列数组被整体替换（清空 / 导入）时递增，用于跳过导航图不必要的重建。 */
let dataGen = 0;
/** 导航图最近一次 setData 时的代数与长度；仅数据变化时才重建导航图（X 窗口拖动不触碰它）。 */
let appliedNavGen = -1;
let appliedNavLen = -1;

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
export function syncChartSeries() {
  const cs = state.chartSeries;
  mainData = [cs.x, cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
  navData = [cs.x, cs.power];
  seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
  seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
  scannedLen = 0;
  dataGen++;
  trackNewPoints();
}

/** 增量扫描新追加的数据点，维护每条曲线的全量最大值。 */
function trackNewPoints() {
  const len = mainData[0].length;
  if (len <= scannedLen) {
    scannedLen = len;
    return;
  }
  for (let si = 1; si < mainData.length; si++) {
    const arr = mainData[si];
    let max = seriesMax[si];
    let min = seriesMin[si];
    for (let i = scannedLen; i < len; i++) {
      const v = arr[i];
      if (Number.isFinite(v)) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    seriesMax[si] = max;
    seriesMin[si] = min;
  }
  scannedLen = len;
}

/** 将当前数据应用到两个图表（范围由各 scale 的 range 函数自动计算）。 */
function applyData() {
  trackNewPoints();
  if (state.mainChart) state.mainChart.setData(/** @type {any} */ (mainData));

  // 导航图始终显示全量数据，仅在数据本身变化（追加 / 替换）时重建；
  // 纯 X 窗口变化（拖动范围滑块）跳过，避免大数据量下的无谓全量路径重建。
  const nav = state.navigatorChart;
  if (nav && (appliedNavGen !== dataGen || appliedNavLen !== navData[0].length)) {
    nav.setData(/** @type {any} */ (navData));
    appliedNavGen = dataGen;
    appliedNavLen = navData[0].length;
  }
}

/** 立即刷新两个图表。 */
export function updateCharts() {
  applyData();
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
 * 视图隐藏期间 ResizeObserver 只会收到 0×0（已被守卫忽略），重新显示后
 * 大多数环境会补发一次正确尺寸，但不保证；这里显式对齐宿主尺寸并刷新。
 */
export function handleMonitorShown() {
  /** @param {string} hostId @param {any} chart */
  const fit = (hostId, chart) => {
    const host = document.getElementById(hostId);
    if (!host || !chart) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0) chart.setSize({ width, height });
  };
  fit('main-chart', state.mainChart);
  fit('navigator-chart', state.navigatorChart);
  updateCharts();
}

/** 使用 requestAnimationFrame 调度图表更新，避免每个数据点都触发重绘。 */
export function scheduleChartUpdate() {
  if (state.__chartUpdatePending) return;
  state.__chartUpdatePending = true;
  requestAnimationFrame(() => {
    state.__chartUpdatePending = false;
    applyData();
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
    const xs = mainData[0];
    if (!xs.length) return [0, 60];
    min = xs[0];
    max = xs[xs.length - 1];
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
 * 文字、刻度又依赖等分数，读 bbox 会形成布局循环。60 是坐标轴与标签的大致占用，
 * 余下按约 80px/格换算——只随窗口尺寸变化，不随数据抖动。
 * @param {any} u
 * @returns {number}
 */
function yDivisions(u) {
  const plotHeight = Math.max(80, (Number(u?.height) || 300) - 60);
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
 * 构造一条 Y 轴配置。
 * 颜色参数为读取 chartTheme 的闭包（uPlot 对 stroke 支持函数形式），换主题后 redraw 即生效。
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
    label,
    labelFont: `12px ${CHART_FONT}`,
    labelSize: 16,
    labelGap: 2,
    font: `12px ${MONO_FONT}`,
    gap: 4,
    size: axisAutoSize,
    // 等分刻度由 uniformSplits 决定，uPlot 基于 space / incrs 的自动选点被完全覆盖
    splits: (/** @type {any} */ u) => uniformSplits(u, scaleKey),
    values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map(smartTick),
    // 四条 Y 轴画同一套主网格：量程已量化到相同的高度比例，像素级重合；
    // 令牌是不透明色，重复描边不会叠亮（见 tokens.css 的说明）
    grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
    // 刻度线与网格解耦：刻度线用通道色，一眼看出哪条轴对应哪条曲线
    ticks: { show: true, stroke: color, width: 1, size: 6 },
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
        const xVal = u.data[0][idx];
        if (xVal == null) {
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
          const yVal = u.data[si][idx];
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
function observeResize(host, chart) {
  const ro = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0) chart.setSize({ width, height });
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
    cursor: {
      y: false,
      drag: { setScale: false, x: false, y: false },
      points: { size: 8 },
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
      drawAxes: [drawMinorGrid],
      setSize: [syncDivisionsAfterResize],
    },
    plugins: [tooltipPlugin()],
  };

  state.mainChart = new uPlot(opts, /** @type {any} */ (mainData), host);
  observeResize(host, state.mainChart);
  renderLegend();
  onThemeChange(applyChartTheme);

  initNavigatorChart();

  // 本地字体较大，首次 canvas 绘制可能发生在字体下载完成前；完成后重绘一次。
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
  observeResize(host, state.navigatorChart);
}
