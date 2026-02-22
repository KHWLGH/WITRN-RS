// @ts-check
/**
 * @file Chart.js 初始化、降采样算法、渲染调度。
 */

import { state, DOWNSAMPLE_CONFIG, DOWNSAMPLE_LEVELS } from './state.js';
import { formatRelativeHMS, hexToRgba } from './utils.js';

// ─── Rendering schedule ──────────────────────────────────────────────────────

/** 使用 requestAnimationFrame 调度图表更新，避免每个数据点都触发重绘。 */
export function scheduleChartUpdate() {
  if (state.__chartUpdatePending) return;
  state.__chartUpdatePending = true;
  requestAnimationFrame(() => {
    state.__chartUpdatePending = false;

    checkAndRebuildDownsampledData();

    const lastX = state.chartSeries.power.length
      ? (state.chartSeries.power[state.chartSeries.power.length - 1]?.x ?? 0)
      : 0;

    if (state.navigatorChart?.options?.scales?.x) {
      const navPad = Math.max(lastX * 0.005, 0.05);
      state.navigatorChart.options.scales.x.min = -navPad;
      state.navigatorChart.options.scales.x.max = lastX + navPad;
    }

    if (state.mainChart) state.mainChart.update('none');
    if (state.navigatorChart) state.navigatorChart.update('none');
  });
}

// ─── LTTB downsampling ───────────────────────────────────────────────────────

/**
 * LTTB (Largest-Triangle-Three-Buckets) 降采样算法。
 * @param {import('./state.js').ChartPoint[]} data
 * @param {number} threshold - 目标点数
 * @returns {import('./state.js').ChartPoint[]}
 */
export function lttbDownsample(data, threshold) {
  const dataLength = data.length;
  if (threshold >= dataLength || threshold <= 2) {
    return data;
  }

  const sampled = new Array(threshold);
  let sampledIndex = 0;
  sampled[sampledIndex++] = data[0];

  const bucketSize = (dataLength - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, dataLength - 1);

    const nextBucketStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, dataLength - 1);

    let avgX = 0;
    let avgY = 0;
    const avgCount = nextBucketEnd - nextBucketStart;

    if (avgCount > 0) {
      for (let j = nextBucketStart; j < nextBucketEnd; j++) {
        avgX += data[j].x;
        avgY += data[j].y;
      }
      avgX /= avgCount;
      avgY /= avgCount;
    } else {
      avgX = data[dataLength - 1].x;
      avgY = data[dataLength - 1].y;
    }

    let maxArea = -1;
    let maxAreaIndex = bucketStart;

    const pointAX = data[a].x;
    const pointAY = data[a].y;

    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (data[j].y - pointAY) -
        (pointAX - data[j].x) * (avgY - pointAY),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    sampled[sampledIndex++] = data[maxAreaIndex];
    a = maxAreaIndex;
  }

  sampled[sampledIndex] = data[dataLength - 1];
  return sampled;
}

// ─── MinMax downsampling ─────────────────────────────────────────────────────

/**
 * MinMax 降采样 — 用于导航器，比 LTTB 更快并保留极值。
 * @param {import('./state.js').ChartPoint[]} data
 * @param {number} buckets
 * @returns {import('./state.js').ChartPoint[]}
 */
export function minMaxDownsample(data, buckets) {
  const dataLength = data.length;
  if (buckets * 2 >= dataLength || buckets <= 1) {
    return data;
  }

  /** @type {import('./state.js').ChartPoint[]} */
  const result = [];
  const bucketSize = dataLength / buckets;

  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(Math.floor((i + 1) * bucketSize), dataLength);

    let minY = Infinity;
    let maxY = -Infinity;
    let minIdx = start;
    let maxIdx = start;

    for (let j = start; j < end; j++) {
      if (data[j].y < minY) { minY = data[j].y; minIdx = j; }
      if (data[j].y > maxY) { maxY = data[j].y; maxIdx = j; }
    }

    if (minIdx <= maxIdx) {
      result.push(data[minIdx]);
      if (minIdx !== maxIdx) result.push(data[maxIdx]);
    } else {
      result.push(data[maxIdx]);
      if (minIdx !== maxIdx) result.push(data[minIdx]);
    }
  }

  return result;
}

// ─── Rebuild helpers ─────────────────────────────────────────────────────────

/**
 * 获取当前生效的主图表最大渲染点数。
 * 降采样关闭时返回 Infinity（不限制），开启时按挡位映射。
 */
function getEffectiveMaxPoints() {
  if (!state.settings.downsampleEnabled) return Infinity;
  return DOWNSAMPLE_LEVELS[state.settings.downsampleLevel] ?? DOWNSAMPLE_CONFIG.mainChartMaxPoints;
}

/** 重建主图表降采样渲染序列。 */
export function rebuildRenderSeries() {
  const count = state.chartSeries.voltage.length;
  const maxPoints = getEffectiveMaxPoints();

  if (count <= maxPoints) {
    state.renderSeries.voltage = state.chartSeries.voltage;
    state.renderSeries.current = state.chartSeries.current;
    state.renderSeries.power = state.chartSeries.power;
    state.renderSeries.temp = state.chartSeries.temp;
  } else {
    state.renderSeries.voltage = lttbDownsample(state.chartSeries.voltage, maxPoints);
    state.renderSeries.current = lttbDownsample(state.chartSeries.current, maxPoints);
    state.renderSeries.power = lttbDownsample(state.chartSeries.power, maxPoints);
    state.renderSeries.temp = lttbDownsample(state.chartSeries.temp, maxPoints);
  }

  DOWNSAMPLE_CONFIG.lastRebuildCount = count;

  if (state.mainChart) {
    state.mainChart.data.datasets[0].data = state.renderSeries.voltage;
    state.mainChart.data.datasets[1].data = state.renderSeries.current;
    state.mainChart.data.datasets[2].data = state.renderSeries.power;
    state.mainChart.data.datasets[3].data = state.renderSeries.temp;
  }
}

/** 重建导航器降采样序列（更激进的降采样）。 */
export function rebuildNavigatorSeries() {
  const count = state.chartSeries.power.length;

  if (count <= DOWNSAMPLE_CONFIG.navigatorMaxPoints) {
    state.navigatorSeries.power = state.chartSeries.power;
  } else {
    state.navigatorSeries.power = minMaxDownsample(state.chartSeries.power, DOWNSAMPLE_CONFIG.navigatorMaxPoints / 2);
  }

  DOWNSAMPLE_CONFIG.navLastRebuildCount = count;

  if (state.navigatorChart) {
    state.navigatorChart.data.datasets[0].data = state.navigatorSeries.power;
  }
}

/** 检查是否需要重建降采样数据（阈值触发，避免每个数据点都重建）。 */
export function checkAndRebuildDownsampledData() {
  const count = state.chartSeries.voltage.length;
  const lastCount = DOWNSAMPLE_CONFIG.lastRebuildCount;
  const navLastCount = DOWNSAMPLE_CONFIG.navLastRebuildCount;
  const now = performance.now();

  const maxPoints = getEffectiveMaxPoints();

  // 数据量较小或降采样关闭时直接引用原始数据
  if (count <= maxPoints) {
    if (state.renderSeries.voltage !== state.chartSeries.voltage) {
      state.renderSeries.voltage = state.chartSeries.voltage;
      state.renderSeries.current = state.chartSeries.current;
      state.renderSeries.power = state.chartSeries.power;
      state.renderSeries.temp = state.chartSeries.temp;
      if (state.mainChart) {
        state.mainChart.data.datasets[0].data = state.renderSeries.voltage;
        state.mainChart.data.datasets[1].data = state.renderSeries.current;
        state.mainChart.data.datasets[2].data = state.renderSeries.power;
        state.mainChart.data.datasets[3].data = state.renderSeries.temp;
      }
    }
    DOWNSAMPLE_CONFIG.lastRebuildCount = count;
  } else {
    const timeSinceLastRebuild = now - DOWNSAMPLE_CONFIG.lastRebuildTime;
    const growthRatio = lastCount > 0 ? (count - lastCount) / lastCount : 1;

    const mainNeedsRebuild = lastCount === 0
      || (growthRatio > DOWNSAMPLE_CONFIG.rebuildThreshold
        && timeSinceLastRebuild >= DOWNSAMPLE_CONFIG.minRebuildInterval);

    if (mainNeedsRebuild) {
      rebuildRenderSeries();
      DOWNSAMPLE_CONFIG.lastRebuildTime = now;
    } else if (state.renderSeries.voltage.length > 0) {
      // 保持尾部对齐，让图表末端跟踪最新数据点
      const lastVoltage = state.chartSeries.voltage[count - 1];
      const lastCurrent = state.chartSeries.current[count - 1];
      const lastPower = state.chartSeries.power[count - 1];
      const lastTemp = state.chartSeries.temp[count - 1];
      state.renderSeries.voltage[state.renderSeries.voltage.length - 1] = lastVoltage;
      state.renderSeries.current[state.renderSeries.current.length - 1] = lastCurrent;
      state.renderSeries.power[state.renderSeries.power.length - 1] = lastPower;
      if (lastTemp && state.renderSeries.temp.length > 0) {
        state.renderSeries.temp[state.renderSeries.temp.length - 1] = lastTemp;
      }
    }
  }

  // Navigator rebuild check
  if (count <= DOWNSAMPLE_CONFIG.navigatorMaxPoints) {
    if (state.navigatorSeries.power !== state.chartSeries.power) {
      state.navigatorSeries.power = state.chartSeries.power;
      if (state.navigatorChart) {
        state.navigatorChart.data.datasets[0].data = state.navigatorSeries.power;
      }
    }
    DOWNSAMPLE_CONFIG.navLastRebuildCount = count;
  } else {
    const navGrowthRatio = navLastCount > 0 ? (count - navLastCount) / navLastCount : 1;
    const navNeedsRebuild = navLastCount === 0
      || navGrowthRatio > DOWNSAMPLE_CONFIG.rebuildThreshold;

    if (navNeedsRebuild) {
      rebuildNavigatorSeries();
    } else if (state.navigatorSeries.power.length > 0) {
      state.navigatorSeries.power[state.navigatorSeries.power.length - 1] = state.chartSeries.power[count - 1];
    }
  }
}

// ─── Chart initialization ────────────────────────────────────────────────────

/** 初始化主图表。 */
export function initChart() {
  const ctx = /** @type {HTMLCanvasElement} */ (document.getElementById('main-chart')).getContext('2d');
  const chartFontFamily = "'Microsoft YaHei UI', 'Microsoft YaHei', 'SimHei', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif";
  const monoFontFamily = "'JetBrains Mono', 'Consolas', 'Monaco', monospace";

  const colors = {
    voltage: '#4a9eff',
    current: '#4aff9f',
    power: '#ffaa4a',
    temp: '#ff4a4a',
  };

  /** @param {number} value @returns {string|number} */
  const smartTickCallback = (value) => {
    const absVal = Math.abs(value);
    if (absVal > 0 && absVal < 0.001) return parseFloat(value.toFixed(6));
    if (absVal > 0 && absVal < 0.1) return parseFloat(value.toFixed(5));
    if (absVal > 0 && absVal < 1) return parseFloat(value.toFixed(4));
    return parseFloat(value.toFixed(3));
  };

  // @ts-ignore — Chart is a global from chart.umd.min.js
  state.mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: '电压',
          data: state.renderSeries.voltage,
          borderColor: colors.voltage,
          backgroundColor: hexToRgba(colors.voltage, state.settings.opacityVoltage),
          yAxisID: 'y-voltage',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: state.settings.fillVoltage,
          hidden: !state.settings.showVoltage,
        },
        {
          label: '电流',
          data: state.renderSeries.current,
          borderColor: colors.current,
          backgroundColor: hexToRgba(colors.current, state.settings.opacityCurrent),
          yAxisID: 'y-current',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: state.settings.fillCurrent,
          hidden: !state.settings.showCurrent,
        },
        {
          label: '功率',
          data: state.renderSeries.power,
          borderColor: colors.power,
          backgroundColor: hexToRgba(colors.power, state.settings.opacityPower),
          yAxisID: 'y-power',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: state.settings.fillPower,
          hidden: !state.settings.showPower,
        },
        {
          label: '温度',
          data: state.renderSeries.temp,
          borderColor: colors.temp,
          backgroundColor: hexToRgba(colors.temp, state.settings.opacityTemp),
          yAxisID: 'y-temp',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: state.settings.fillTemp,
          hidden: !state.settings.showTemp,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      animation: { duration: 0 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          onClick: () => {},
          labels: {
            color: '#a0a0b0',
            usePointStyle: true,
            font: { family: chartFontFamily },
            padding: 15,
            generateLabels: (chart) => {
              // @ts-ignore
              const original = Chart.defaults.plugins.legend.labels.generateLabels;
              return original(chart).filter((/** @type {any} */ item) => chart.isDatasetVisible(item.datasetIndex));
            },
          },
        },
        decimation: { enabled: false },
        tooltip: {
          backgroundColor: 'rgba(30, 30, 50, 0.95)',
          titleColor: '#e8e8f0',
          bodyColor: '#a0a0b0',
          titleFont: { family: monoFontFamily },
          bodyFont: { family: monoFontFamily },
          borderColor: '#2a2a4a',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            title: (/** @type {any[]} */ items) => {
              if (!items || items.length === 0) return '';
              const seconds = Number(items[0].parsed?.x ?? 0);
              return formatRelativeHMS(seconds);
            },
            label: (/** @type {any} */ context) => {
              let label = context.dataset.label || '';
              if (label) label += ': ';
              if (context.parsed.y !== null) {
                label += context.parsed.y.toFixed(3);
                const units = [' V', ' A', ' W', ' °C'];
                if (context.datasetIndex >= 0 && context.datasetIndex < units.length) {
                  label += units[context.datasetIndex];
                }
              }
              return label;
            },
          },
        },
        zoom: {
          zoom: { wheel: { enabled: false }, pinch: { enabled: false }, mode: 'xy' },
          pan: { enabled: false, mode: 'xy' },
        },
      },
      scales: {
        x: {
          type: 'linear',
          bounds: 'data',
          offset: false,
          grace: 0,
          grid: { color: 'rgba(42, 42, 74, 0.5)', drawBorder: false },
          ticks: {
            color: '#6a6a7a',
            font: { family: monoFontFamily },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            callback: (/** @type {number} */ value) => formatRelativeHMS(Number(value)),
          },
        },
        'y-voltage': {
          type: 'linear',
          display: state.settings.showVoltage,
          position: 'left',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: { display: true, text: '电压 (V)', color: '#4a9eff', font: { family: chartFontFamily } },
          grid: { color: 'rgba(74, 158, 255, 0.1)', drawBorder: false },
          ticks: { color: '#4a9eff', font: { family: monoFontFamily }, callback: smartTickCallback },
        },
        'y-current': {
          type: 'linear',
          display: state.settings.showCurrent,
          position: 'left',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: { display: true, text: '电流 (A)', color: '#4aff9f', font: { family: chartFontFamily } },
          grid: { display: false },
          ticks: { color: '#4aff9f', font: { family: monoFontFamily }, callback: smartTickCallback },
        },
        'y-power': {
          type: 'linear',
          display: state.settings.showPower,
          position: 'right',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: { display: true, text: '功率 (W)', color: '#ffaa4a', font: { family: chartFontFamily } },
          grid: { display: false },
          ticks: { color: '#ffaa4a', font: { family: monoFontFamily }, callback: smartTickCallback },
        },
        'y-temp': {
          type: 'linear',
          display: state.settings.showTemp,
          position: 'right',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: { display: true, text: '温度 (°C)', color: '#ff4a4a', font: { family: chartFontFamily } },
          grid: { display: false },
          ticks: {
            color: '#ff4a4a',
            font: { family: monoFontFamily },
            callback: (/** @type {number} */ value) => parseFloat(value.toFixed(3)),
          },
        },
      },
    },
  });

  initNavigatorChart();
}

/** 初始化导航器图表。 */
export function initNavigatorChart() {
  const ctx = /** @type {HTMLCanvasElement} */ (document.getElementById('navigator-chart')).getContext('2d');

  // @ts-ignore — Chart is a global
  state.navigatorChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        data: state.navigatorSeries.power,
        borderColor: '#ffaa4a',
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { type: 'linear', display: false, bounds: 'data', offset: false, grace: 0 },
        y: { display: false, type: 'linear', beginAtZero: true, grace: '5%' },
      },
      layout: { padding: 0 },
    },
  });
}
