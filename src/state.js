// @ts-check
/**
 * @file 共享应用状态 — 所有模块通过此对象交换可变数据。
 *
 * 设计原则：
 * - 用单一可变对象 `state` 代替散落的全局 let，避免 ES-module live-binding 的 setter 泛滥。
 * - 类型定义（@typedef）集中在此文件，其余模块通过 `import('./state.js')` 引用。
 */

// ─── Type Definitions ────────────────────────────────────────────────────────

/**
 * 来自 Rust 后端 HID 解析的设备数据。
 * @typedef {Object} DeviceData
 * @property {number} voltage  - 电压 (V)
 * @property {number} current  - 电流 (A)，可为负值
 * @property {number} power    - 功率 (W)，可为负值
 * @property {number} [dp]     - D+ 电压
 * @property {number} [dn]     - D- 电压
 * @property {number} [cc1]    - CC1 电压
 * @property {number} [cc2]    - CC2 电压
 * @property {number} [temperature] - 设备温度 (°C)
 * @property {number} [ah]     - 累计容量 (Ah)
 * @property {number} [wh]     - 累计能量 (Wh)
 */

/**
 * 应用设置。
 * @typedef {Object} Settings
 * @property {number} rangeStart
 * @property {number} rangeEnd
 * @property {number} sampleRate      - 采样间隔 (ms)
 * @property {boolean} showVoltage
 * @property {boolean} showCurrent
 * @property {boolean} showPower
 * @property {boolean} showTemp
 * @property {number}  opacityVoltage
 * @property {number}  opacityCurrent
 * @property {number}  opacityPower
 * @property {number}  opacityTemp
 * @property {boolean} statsRange
 * @property {string}  tempIp
 * @property {number}  tempPort
 * @property {'device'|'external'} tempSource - 温度来源：本机仪表 / 外部 TCP
 * @property {string}  activeView       - 上次活动的工作区视图 id
 * @property {boolean} pdFollowRecording - PD 采集是否跟随主记录状态
 * @property {'auto'|'custom'} chartHeadroomMode - 图表纵向余量：auto=软件决定，custom=用户自定义
 * @property {number}  chartHeadroomPercent - 自定义纵向余量百分比（0-100）
 * @property {boolean} showDpDn - 图表叠加 D+/D- 曲线
 * @property {boolean} showCc   - 图表叠加 CC1/CC2 曲线
 * @property {boolean} signedCurrent - 记录电流方向：开=保留符号（反向为负），关=记录绝对值
 * @property {number}  uiScalePercent - 界面等比缩放百分比（50–200，步进 5；100=跟随系统 DPI）
 * @property {'dark'|'light'|'system'} theme - 外观：深色 / 浅色 / 跟随系统
 * @property {boolean} windowMaterial - Win11 Mica 窗口材质（不可用时由运行时忽略）
 * @property {number}  realtimePanelWidth - 监控页读数栏宽度（px，200–360）
 * @property {boolean} pdSplitSide - PD 分析宽屏时采用左右分栏
 */

/**
 * 自动暂停设置。
 * @typedef {Object} AutoPauseSettings
 * @property {boolean} enabled
 * @property {'none'|'voltage'|'current'|'power'} basis
 * @property {number}  condition
 * @property {number}  duration     - 触发持续时间（秒）
 * @property {number|null} triggerStartTime
 */

/**
 * 统计值。
 * @typedef {Object} StatEntry
 * @property {number} min
 * @property {number} max
 * @property {number} sum
 * @property {number} count
 */

/**
 * 能量累计。
 * @typedef {Object} Energy
 * @property {number} wh
 * @property {number} mah
 * @property {number|null} lastX - 上一个已积分点的相对秒；录制段开始为 null
 */

/**
 * 可扩容 Float64 列。uPlot 吃 `view()`（连续 f64，零拷贝）；应用侧用 length / at / buf[i] / push。
 * 采集时倍增扩容，避免普通数组周期性整列拷贝与装箱。
 */
export class F64Col {
  /** @param {number} [capacity=4096] */
  constructor(capacity = 4096) {
    const cap = Math.max(1, capacity | 0);
    /** @type {Float64Array} */
    this.buf = new Float64Array(cap);
    /** @type {number} */
    this.length = 0;
  }

  /** @param {number} v */
  push(v) {
    if (this.length >= this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }

  /**
   * @param {number} i
   * @returns {number}
   */
  at(i) {
    const idx = i < 0 ? this.length + i : i;
    return this.buf[idx];
  }

  /** @param {ArrayLike<number>} values */
  set(values) {
    const n = values.length;
    if (n > this.buf.length) this.buf = new Float64Array(n);
    this.buf.set(values);
    this.length = n;
  }

  /** @returns {Float64Array} */
  view() {
    return this.buf.subarray(0, this.length);
  }
}

/**
 * 图表列式存储（唯一数据源）。
 * x 为相对秒，timestamps 为墙钟毫秒，其余通道与 x 等长对齐。
 * `state.chartSeries` 是图表列式存储的唯一引用。
 * @typedef {Object} ChartSeriesColumns
 * @property {F64Col} x
 * @property {F64Col} timestamps
 * @property {F64Col} voltage
 * @property {F64Col} current
 * @property {F64Col} power
 * @property {F64Col} temp
 * @property {F64Col} dp
 * @property {F64Col} dn
 * @property {F64Col} cc1
 * @property {F64Col} cc2
 */

/** @param {number} [capacity=4096] @returns {ChartSeriesColumns} */
export function emptyChartColumns(capacity = 4096) {
  return {
    x: new F64Col(capacity),
    timestamps: new F64Col(capacity),
    voltage: new F64Col(capacity),
    current: new F64Col(capacity),
    power: new F64Col(capacity),
    temp: new F64Col(capacity),
    dp: new F64Col(capacity),
    dn: new F64Col(capacity),
    cc1: new F64Col(capacity),
    cc2: new F64Col(capacity),
  };
}

/** 替换图表列。清空、导入后必须调用。 */
export function setChartColumns(cols) {
  state.chartSeries = cols;
}

/**
 * HID 枚举到的设备信息。
 * @typedef {Object} DeviceInfo
 * @property {string} path
 * @property {string} display_name
 * @property {number} vid
 * @property {number} pid
 * @property {string} serial_number
 * @property {string|null} usb_port
 * @property {string} model_name
 * @property {number} interface_number
 * @property {number} usage_page
 */

// ─── Default Settings ────────────────────────────────────────────────────────

/** @type {Settings} */
export const defaultSettings = {
  rangeStart: 0,
  rangeEnd: 1000,
  sampleRate: 250,
  showVoltage: true,
  showCurrent: true,
  showPower: true,
  showTemp: true,
  opacityVoltage: 15,
  opacityCurrent: 15,
  opacityPower: 15,
  opacityTemp: 15,
  statsRange: false,
  tempIp: '127.0.0.1',
  tempPort: 1573,
  tempSource: 'external',
  activeView: 'monitor',
  pdFollowRecording: true,
  chartHeadroomMode: 'auto',
  chartHeadroomPercent: 25,
  showDpDn: false,
  showCc: false,
  signedCurrent: false,
  uiScalePercent: 100,
  theme: 'dark',
  windowMaterial: true,
  realtimePanelWidth: 250,
  pdSplitSide: false,
};

/** @type {AutoPauseSettings} */
export const defaultAutoPauseSettings = {
  enabled: false,
  basis: 'none',
  condition: 0,
  duration: 0,
  triggerStartTime: null,
};

// ─── Shared mutable state ────────────────────────────────────────────────────

const chartColumns = emptyChartColumns();

/**
 * 全局共享可变状态。所有模块通过 `state.xxx` 读写。
 */
export const state = {
  // ── Chart instances ──
  /** @type {any} uPlot 主图表实例 */
  mainChart: null,
  /** @type {any} uPlot 导航器图表实例 */
  navigatorChart: null,

  /** @type {boolean} */
  __chartUpdatePending: false,
  /** @type {((enabled: boolean) => void)|null} */
  __setRangeControlsEnabled: null,
  /**
   * 滚轮缩放：由 data.js 注入，避免 chart.js ↔ data.js 循环 import。
   * @type {((pivotSec: number, factor: number) => void)|null}
   */
  __applyChartXZoom: null,
  /**
   * 由 app.js 注入的两个跨视图动作，供 views/pd.js 在「跟随记录」联动时调用。
   * 用注入而非直接 import：pd.js → data.js 会把 chart.js / temperature.js
   * （顶层解构 window.__TAURI__）拖进 test/pd-*.test.js 的最小 stub 环境。
   */
  /** @type {(() => void)|null} 切换主记录（开始 / 暂停） */
  __toggleRecording: null,
  /** @type {(() => void)|null} 清空图表并重置统计与能量 */
  __clearMonitorData: null,
  /** @type {(() => void)|null} 手动或拔线断开时在 PD 日志插入分隔行 */
  __markPdDisconnect: null,
  /** @type {boolean} 读数栏分栏拖动中：图表的 ResizeObserver 跳过，松手再定尺 */
  __layoutResizing: false,
  /** @type {boolean} 范围手柄或滚轮缩放跟手中：录制 tick 不改写选区 */
  __rangeDragging: false,

  // ── Raw data storage ──
  /** @type {ChartSeriesColumns} */
  chartSeries: chartColumns,

  // ── Statistics ──
  /** @type {{ voltage: StatEntry, current: StatEntry, power: StatEntry, temp: StatEntry }} */
  stats: {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  },

  /** @type {Energy} */
  energy: { wh: 0, mah: 0, lastX: null },

  /**
   * 主图 X 窗会话态（不持久化）。
   * full = 全历史；follow = 右沿贴最新、保 duration；frozen = 定住秒值。
   * @type {{ mode: 'full'|'follow'|'frozen', duration: number, min: number, max: number }}
   */
  chartWindow: { mode: 'full', duration: 0, min: 0, max: 0 },

  // ── Recording ──
  /** @type {boolean} */
  isRecording: false,
  /** @type {number|null} */
  recordingStartTime: null,
  /** @type {number|null} */
  lastRecordingStartTime: null,
  /** @type {number} Relative x coordinate at the start of the active segment. */
  recordingBaseSeconds: 0,

  // ── Connection ──
  /** @type {boolean} */
  isConnected: false,
  /** @type {DeviceInfo[]} */
  deviceList: [],
  /** @type {string|null} */
  selectedDevicePath: null,

  /** @type {boolean} 后端报告当前平台能否启用 Mica */
  windowMaterialAvailable: false,

  // ── Settings ──
  /** @type {Settings} */
  settings: { ...defaultSettings },

  // ── Temperature ──
  /** @type {boolean} */
  isTempConnected: false,
  /** @type {number|null} */
  currentTemp: null,
  /** @type {boolean} */
  hasTempData: false,

  // ── Auto Pause ──
  /** @type {AutoPauseSettings} */
  autoPauseSettings: { ...defaultAutoPauseSettings, triggerStartTime: null },
};
