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
 * 图表序列（uPlot 列式格式）— x 为相对秒数，各序列与 x 等长对齐。
 * @typedef {Object} ChartSeriesColumns
 * @property {number[]} x
 * @property {number[]} voltage
 * @property {number[]} current
 * @property {number[]} power
 * @property {number[]} temp
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

  // ── Raw data storage ──
  /** @type {{ timestamps: number[], voltage: number[], current: number[], power: number[], temp: number[] }} */
  chartData: {
    timestamps: [],
    voltage: [],
    current: [],
    power: [],
    temp: [],
  },

  /** @type {ChartSeriesColumns} */
  chartSeries: {
    x: [],
    voltage: [],
    current: [],
    power: [],
    temp: [],
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
