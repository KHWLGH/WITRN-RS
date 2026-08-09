// @ts-check
/**
 * @file uPlot 图表初始化、渲染调度、交互（tooltip / 图例 / X 轴窗口）。
 *
 * uPlot 由 vendor/uPlot.iife.min.js 以全局变量方式载入（本地文件，无网络依赖）。
 * 数据为列式（columnar）格式：state.chartSeries = { x, voltage, current, power, temp }，
 * 主图直接引用这些数组（[x, v, c, p, t]），追加数据后调用 setData 即可刷新。
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
import { formatRelativeHMS, hexToRgba } from './utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** 数据集顺序（与复选框 / 设置字段一一对应；uPlot series 下标 = 此下标 + 1）。 */
const FIELDS = ['voltage', 'current', 'power', 'temp'];
const LABELS = ['电压', '电流', '功率', '温度'];
const UNITS = [' V', ' A', ' W', ' °C'];

/** 曲线颜色。 */
const COLORS = { voltage: '#4a9eff', current: '#4aff9f', power: '#ffaa4a', temp: '#ff4a4a' };
/** 轴标题 / 刻度文字颜色（温度轴与曲线色略有区别，沿用旧版配色）。 */
const AXIS_COLORS = { voltage: '#4a9eff', current: '#4aff9f', power: '#ffaa4a', temp: '#ff6060' };

const CHART_FONT =
  "'Microsoft YaHei UI', 'Microsoft YaHei', 'SimHei', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif";
const MONO_FONT = "'Noto Sans Mono', 'JetBrains Mono', 'Consolas', 'Monaco', monospace";

/** X 轴刻度步长候选（秒）— 时间友好的取值（覆盖 0.1 秒到月级跨度）。 */
const TIME_INCRS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
  259200, 432000, 604800, 1209600, 2592000, 5184000, 8640000,
];

// ─── Module state ────────────────────────────────────────────────────────────

/** 主图数据（列式）：[x, voltage, current, power, temp]，元素直接引用 state.chartSeries 的数组。 */
/** @type {number[][]} */
let mainData = [[], [], [], [], []];
/** 导航图数据：[x, power]。 */
/** @type {number[][]} */
let navData = [[], []];

/** 范围滑块设定的主图 X 轴窗口；null 表示尚无数据（使用默认范围）。 */
/** @type {{ min: number|null, max: number|null }} */
const xWindow = { min: null, max: null };

/** 每条曲线的填充色（按 series 下标 1..4，null = 不填充）。 */
/** @type {(string|null)[]} */
let fillStyles = [null, null, null, null, null];

/**
 * 每条曲线全量数据的最大值（按 series 下标 1..4）。
 * Y 轴量程基于全量数据而非可见窗口（与旧版 Chart.js 行为一致，避免拖动滑块时 Y 轴跳动）。
 */
/** @type {number[]} */
let seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity];
/** 每条曲线全量数据的最小值（温度轴需要保留负值）。 */
/** @type {number[]} */
let seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity];
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
  mainData = [cs.x, cs.voltage, cs.current, cs.power, cs.temp];
  navData = [cs.x, cs.power];
  seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity];
  seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity];
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
  for (let si = 1; si <= 4; si++) {
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
 * @param {number} datasetIndex - 0=电压 1=电流 2=功率 3=温度
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
    opacityPercent > 0 ? hexToRgba(/** @type {any} */ (COLORS)[field], opacityPercent) : null;
  if (state.mainChart) state.mainChart.redraw();
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
 * 构造 Y 轴范围函数：0 起点 + 全量数据最大值上方 5% 余量。
 * 序列隐藏时返回空量程，uPlot 会自动隐藏对应的轴并释放空间。
 * 注意：量程完全来自模块内的 seriesMax 增量跟踪，因此各 series 均设置
 * auto: false，跳过 uPlot 每次提交时对全量数据的 min/max 扫描（百万级点数下显著提速）。
 * @param {number} si - series 下标（1..4）
 */
function mkYRange(si) {
  return /** @type {any} */ (
    /** @param {any} u */
    (u) => {
      if (!u.series[si] || !u.series[si].show) return [null, null];
      const max = seriesMax[si];
      const min = seriesMin[si];
      if (!Number.isFinite(max)) return [0, 1];
      if (si === 4) {
        const span = max - min;
        const padding = span > 0 ? span * 0.05 : 1;
        return [min - padding, max + padding];
      }
      if (max <= 0) return [0, 1];
      return [0, max * 1.05];
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
 * 生成 1/2/2.5/5×10^k 步长的均匀刻度（温度轴在电压轴不可用时的回退方案）。
 * @param {number} min @param {number} max @param {number} count
 * @returns {number[]}
 */
function niceSplits(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const rawIncr = span / count;
  const mag = 10 ** Math.floor(Math.log10(rawIncr));
  let incr = mag * 10;
  for (const m of [1, 2, 2.5, 5]) {
    if (mag * m >= rawIncr) {
      incr = mag * m;
      break;
    }
  }
  const splits = [];
  for (let v = Math.ceil(min / incr) * incr; v <= max + incr * 1e-9; v += incr) splits.push(v);
  return splits;
}

/**
 * 温度轴刻度：将电压轴的刻度位置按比例映射到温度量程并取整，
 * 使温度刻度与主网格线（电压轴）在同一水平线上（与旧版 afterBuildTicks 行为一致）。
 * @param {any} u
 * @returns {number[]}
 */
function tempSplits(u) {
  const tScale = u.scales.temp;
  if (tScale?.min == null || tScale?.max == null) return [];
  const tMin = Number(tScale.min);
  const tMax = Number(tScale.max);
  const tSpan = tMax - tMin;

  const vScale = u.scales.voltage;
  const vSplits = u.axes?.[1]?._splits;
  /** @type {number[]} */
  let mapped;

  if (vScale?.min != null && vScale?.max != null && Array.isArray(vSplits) && vSplits.length >= 2) {
    const vMin = Number(vScale.min);
    const vSpan = Number(vScale.max) - vMin;
    mapped = vSplits.map((/** @type {number} */ s) => {
      const ratio = vSpan === 0 ? 0 : (s - vMin) / vSpan;
      return Math.round(tMin + ratio * tSpan);
    });
  } else {
    mapped = niceSplits(tMin, tMax, 5).map((v) => Math.round(v));
  }

  return mapped.filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
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
 * @param {string} scaleKey
 * @param {string} label
 * @param {string} color
 * @param {number} side - 3=左 1=右
 * @param {{show: boolean, stroke?: string}} grid
 * @returns {any}
 */
function mkYAxis(scaleKey, label, color, side, grid) {
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
    space: 40,
    size: axisAutoSize,
    values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map(smartTick),
    grid: grid.show ? { show: true, stroke: grid.stroke, width: 1 } : { show: false },
    ticks: grid.show ? { show: true, stroke: grid.stroke, width: 1, size: 6 } : { show: false },
  };
}

// ─── Dense minor grid ────────────────────────────────────────────────────────

/**
 * 在主刻度之间绘制细分网格线（5 等分），使网格更密集。
 * 纵向细分基于 X 轴刻度，横向细分基于电压轴刻度（作为唯一参考，与旧版插件一致）。
 * @param {any} u
 */
function drawMinorGrid(u) {
  const { ctx, bbox } = u;
  if (!bbox || bbox.width <= 0) return;

  const subdivisions = 5;
  const left = bbox.left;
  const right = bbox.left + bbox.width;
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;

  ctx.save();
  ctx.lineWidth = 0.5 * pxRatio;

  // ── Minor vertical grid lines (x-axis) ──
  const xSplits = u.axes?.[0]?._splits;
  if (Array.isArray(xSplits) && xSplits.length >= 2) {
    ctx.strokeStyle = 'rgba(80, 80, 130, 0.5)';
    ctx.beginPath();
    for (let i = 0; i < xSplits.length - 1; i++) {
      const step = (xSplits[i + 1] - xSplits[i]) / subdivisions;
      for (let j = 1; j < subdivisions; j++) {
        const x = u.valToPos(xSplits[i] + step * j, 'x', true);
        if (x >= left && x <= right) {
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
        }
      }
    }
    ctx.stroke();
  }

  // ── Minor horizontal grid lines (voltage axis only, as the single reference) ──
  const vSplits = u.axes?.[1]?._splits;
  if (u.scales.voltage?.min != null && Array.isArray(vSplits) && vSplits.length >= 2) {
    ctx.strokeStyle = 'rgba(120, 130, 160, 0.25)';
    ctx.beginPath();
    for (let i = 0; i < vSplits.length - 1; i++) {
      const step = (vSplits[i + 1] - vSplits[i]) / subdivisions;
      for (let j = 1; j < subdivisions; j++) {
        const y = u.valToPos(vSplits[i] + step * j, 'voltage', true);
        if (y >= top && y <= bottom) {
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
        }
      }
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ─── Legend ──────────────────────────────────────────────────────────────────

/** 渲染顶部图例（仅列出当前可见的曲线，与旧版 generateLabels 过滤逻辑一致）。 */
function renderLegend() {
  const el = document.getElementById('main-chart-legend');
  const chart = state.mainChart;
  if (!el || !chart) return;

  const parts = [];
  for (let si = 1; si < chart.series.length; si++) {
    if (!chart.series[si].show) continue;
    const color = /** @type {any} */ (COLORS)[FIELDS[si - 1]];
    parts.push(
      `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${color}"></span>${LABELS[si - 1]}</span>`,
    );
  }
  el.innerHTML = parts.join('');
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

        let html = `<div class="chart-tooltip-title">${formatRelativeHMS(Number(xVal))}</div>`;
        let rows = 0;
        for (let si = 1; si < u.series.length; si++) {
          if (!u.series[si].show) continue;
          const yVal = u.data[si][idx];
          if (yVal == null || !Number.isFinite(yVal)) continue;
          const color = /** @type {any} */ (COLORS)[FIELDS[si - 1]];
          html += `<div class="chart-tooltip-row"><span class="chart-tooltip-swatch" style="background:${color}"></span>${LABELS[si - 1]}: ${Number(yVal).toFixed(3)}${UNITS[si - 1]}</div>`;
          rows++;
        }
        if (rows === 0) {
          tt.style.display = 'none';
          return;
        }

        tt.innerHTML = html;
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

  syncChartSeries();

  splineBuilder = uPlot.paths?.spline ? uPlot.paths.spline() : null;
  linearBuilder = uPlot.paths?.linear ? uPlot.paths.linear() : null;
  const hasPaths = splineBuilder != null || linearBuilder != null;

  const s = state.settings;
  fillStyles = [
    null,
    s.opacityVoltage > 0 ? hexToRgba(COLORS.voltage, s.opacityVoltage) : null,
    s.opacityCurrent > 0 ? hexToRgba(COLORS.current, s.opacityCurrent) : null,
    s.opacityPower > 0 ? hexToRgba(COLORS.power, s.opacityPower) : null,
    s.opacityTemp > 0 ? hexToRgba(COLORS.temp, s.opacityTemp) : null,
  ];

  const showInitial = [
    s.showVoltage,
    s.showCurrent,
    s.showPower,
    s.showTemp && (state.isTempConnected || state.hasTempData),
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
      voltage: { range: mkYRange(1) },
      current: { range: mkYRange(2) },
      power: { range: mkYRange(3) },
      temp: { range: mkYRange(4) },
    },
    series: [
      {},
      ...FIELDS.map((field, i) => ({
        label: LABELS[i],
        scale: field,
        auto: false,
        stroke: /** @type {any} */ (COLORS)[field],
        width: 1.5,
        points: { show: false },
        ...(hasPaths ? { paths: adaptivePaths } : {}),
        fill: () => fillStyles[i + 1],
        show: showInitial[i],
      })),
    ],
    axes: [
      {
        scale: 'x',
        stroke: '#9a9ab8',
        font: `12px ${MONO_FONT}`,
        size: 34,
        gap: 4,
        space: 80,
        incrs: TIME_INCRS,
        values: (/** @type {any} */ _u, /** @type {number[]} */ splits) =>
          splits.map((v) => formatRelativeHMS(Number(v))),
        grid: { show: true, stroke: 'rgba(90, 90, 140, 0.75)', width: 1 },
        ticks: { show: true, stroke: 'rgba(90, 90, 140, 0.75)', width: 1, size: 8 },
      },
      mkYAxis('voltage', '电压 (V)', AXIS_COLORS.voltage, 3, { show: true, stroke: 'rgba(74, 158, 255, 0.22)' }),
      mkYAxis('current', '电流 (A)', AXIS_COLORS.current, 3, { show: false }),
      mkYAxis('power', '功率 (W)', AXIS_COLORS.power, 1, { show: false }),
      {
        ...mkYAxis('temp', '温度 (°C)', AXIS_COLORS.temp, 1, { show: false }),
        splits: /** @type {any} */ ((/** @type {any} */ u) => tempSplits(u)),
        values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map((v) => String(Math.round(v))),
      },
    ],
    hooks: {
      drawAxes: [drawMinorGrid],
    },
    plugins: [tooltipPlugin()],
  };

  state.mainChart = new uPlot(opts, /** @type {any} */ (mainData), host);
  observeResize(host, state.mainChart);
  renderLegend();

  initNavigatorChart();
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
            return [0, Number.isFinite(max) && max > 0 ? max * 1.05 : 1];
          }
        ),
      },
    },
    series: [
      {},
      {
        scale: 'y',
        auto: false,
        stroke: '#ffaa4a',
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
