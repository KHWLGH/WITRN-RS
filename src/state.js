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
 * 录制的单条数据记录。
 * @typedef {Object} RecordedRow
 * @property {string} timestamp   - 相对时间字符串 HH:mm:ss.s
 * @property {number} voltage
 * @property {number} current
 * @property {number} power
 * @property {number} temp
 * @property {number} relSeconds  - 相对录制开始的秒数
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
 * @property {boolean} fillVoltage
 * @property {number}  opacityVoltage
 * @property {boolean} fillCurrent
 * @property {number}  opacityCurrent
 * @property {boolean} fillPower
 * @property {number}  opacityPower
 * @property {boolean} fillTemp
 * @property {number}  opacityTemp
 * @property {boolean} statsRange
 * @property {boolean} downsampleEnabled
 * @property {'low'|'medium'|'high'} downsampleLevel
 * @property {string}  tempIp
 * @property {number}  tempPort
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
 * @property {number|null} lastTimestamp
 */

/**
 * Chart.js 数据点。
 * @typedef {{ x: number, y: number }} ChartPoint
 */

/**
 * HID 枚举到的设备信息。
 * @typedef {Object} DeviceInfo
 * @property {string} path
 * @property {string} display_name
 * @property {number} vid
 * @property {number} pid
 * @property {string} serial_number
 * @property {string} model_name
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
  fillVoltage: true,
  opacityVoltage: 15,
  fillCurrent: true,
  opacityCurrent: 15,
  fillPower: true,
  opacityPower: 15,
  fillTemp: true,
  opacityTemp: 15,
  statsRange: false,
  downsampleEnabled: true,
  downsampleLevel: 'medium',
  tempIp: '127.0.0.1',
  tempPort: 1573,
};

/** @type {AutoPauseSettings} */
export const defaultAutoPauseSettings = {
  enabled: false,
  basis: 'none',
  condition: 0,
  duration: 0,
  triggerStartTime: null,
};

// ─── Downsampling configuration ──────────────────────────────────────────────

/** 降采样挡位 → 主图表最大渲染点数映射（强度越高点数越少） */
export const DOWNSAMPLE_LEVELS = /** @type {const} */ ({ low: 5000, medium: 2000, high: 500 });

export const DOWNSAMPLE_CONFIG = {
  mainChartMaxPoints: 2000,
  navigatorMaxPoints: 500,
  rebuildThreshold: 0.15,
  minRebuildInterval: 500,
  lastRebuildCount: 0,
  navLastRebuildCount: 0,
  lastRebuildTime: 0,
  useDirectReference: true,
};

// ─── Shared mutable state ────────────────────────────────────────────────────

/**
 * 全局共享可变状态。所有模块通过 `state.xxx` 读写。
 */
export const state = {
  // ── Chart instances ──
  /** @type {any} Chart.js main chart instance */
  mainChart: null,
  /** @type {any} Chart.js navigator chart instance */
  navigatorChart: null,

  /** @type {boolean} */
  __chartUpdatePending: false,
  /** @type {((enabled: boolean) => void)|null} */
  __setRangeControlsEnabled: null,

  // ── Raw data storage ──
  /** @type {{ timestamps: number[], voltage: number[], current: number[], power: number[], temp: number[] }} */
  chartData: {
    timestamps: [],
    voltage: [],
    current: [],
    power: [],
    temp: [],
  },

  /** @type {{ voltage: ChartPoint[], current: ChartPoint[], power: ChartPoint[], temp: ChartPoint[] }} */
  chartSeries: {
    voltage: [],
    current: [],
    power: [],
    temp: [],
  },

  /** @type {{ voltage: ChartPoint[], current: ChartPoint[], power: ChartPoint[], temp: ChartPoint[] }} */
  renderSeries: {
    voltage: [],
    current: [],
    power: [],
    temp: [],
  },

  /** @type {{ power: ChartPoint[] }} */
  navigatorSeries: {
    power: [],
  },

  // ── Statistics ──
  /** @type {{ voltage: StatEntry, current: StatEntry, power: StatEntry, temp: StatEntry }} */
  stats: {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  },

  /** @type {Energy} */
  energy: { wh: 0, mah: 0, lastTimestamp: null },

  // ── Recording ──
  /** @type {RecordedRow[]} */
  recordedData: [],
  /** @type {boolean} */
  isRecording: false,
  /** @type {number|null} */
  recordingStartTime: null,
  /** @type {number|null} */
  lastRecordingStartTime: null,
  /** @type {boolean} */
  collectWhenRecordingOnly: true,

  // ── Connection ──
  /** @type {boolean} */
  isConnected: false,
  /** @type {DeviceInfo[]} */
  deviceList: [],
  /** @type {string|null} */
  selectedDevicePath: null,

  // ── Settings ──
  /** @type {Settings} */
  settings: { ...defaultSettings },

  // ── Temperature ──
  /** @type {any} */
  tempSocket: null,
  /** @type {boolean} */
  isTempConnected: false,
  /** @type {number|null} */
  currentTemp: null,
  /** @type {string} */
  tempBuffer: '',
  /** @type {boolean} */
  hasTempData: false,

  // ── Auto Pause ──
  /** @type {AutoPauseSettings} */
  autoPauseSettings: { ...defaultAutoPauseSettings, triggerStartTime: null },
};
