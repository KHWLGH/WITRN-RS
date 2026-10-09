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
 * @property {'auto'|'zh-CN'|'zh-TW'|'en'|'ja'} language - 界面语言；auto=跟随系统
 * @property {'auto'|'windows'|'macos'} windowStyle - 窗口风格；与真实平台及窗口动作分离
 * @property {number}  realtimePanelWidth - 监控页读数栏宽度（px，200–360）
 * @property {boolean} pdSplitSide - PD 分析宽屏时采用左右分栏
 * @property {{ pdType: number, em: number, sink: number }} km003cPdm - POWER-Z PDM 参数（PD 类型 / 线缆模拟 / Sink）
 * @property {number}  recordLimitMb - 单次记录上限（MB，64–8192；按 112 字节/点换算点数）
 * @property {boolean} recordingTempSpool - 记录时保留应用缓存中的临时恢复文件
 * @property {boolean} autoSaveRecording - 旧设置兼容别名；新代码使用 recordingTempSpool
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

export const F64_CHUNK_SIZE = 4096;

/** Fixed-prefix view. Appends to the source cannot change its length or chunk list. */
export class F64Snapshot {
  /** @param {Float64Array[]} chunks @param {number} length */
  constructor(chunks, length) {
    this._chunks = chunks;
    this.length = length;
  }

  /** Valid indices return their exact stored value; out-of-range reads follow typed-array semantics. @param {number} i @returns {number} */
  valueAt(i) {
    return /** @type {number} */ (
      i >= 0 && i < this.length ? this._chunks[i >>> 12]?.[i & (F64_CHUNK_SIZE - 1)] : undefined
    );
  }

  /** @param {number} i */
  at(i) {
    return this.valueAt(i < 0 ? this.length + i : i);
  }

  /** @param {number} [start=0] @param {number} [end=this.length] */
  *chunks(start = 0, end = this.length) {
    const from = Math.max(0, Math.min(this.length, start));
    const to = Math.max(from, Math.min(this.length, end));
    for (let offset = from; offset < to; ) {
      const chunkIndex = offset >>> 12;
      const stop = Math.min(to, (chunkIndex + 1) * F64_CHUNK_SIZE);
      yield {
        offset,
        values: this._chunks[chunkIndex].subarray(offset & (F64_CHUNK_SIZE - 1), stop - chunkIndex * F64_CHUNK_SIZE),
      };
      offset = stop;
    }
  }

  /** @param {(values: Float64Array, offset: number) => void} callback @param {number} [start=0] @param {number} [end=this.length] */
  forEachChunk(callback, start = 0, end = this.length) {
    for (const { values, offset } of this.chunks(start, end)) callback(values, offset);
  }

  /** @param {number} [start=0] @param {number} [end=this.length] */
  copyRange(start = 0, end = this.length) {
    const from = Math.max(0, Math.min(this.length, start));
    const to = Math.max(from, Math.min(this.length, end));
    const copy = new Float64Array(to - from);
    this.forEachChunk((values, offset) => copy.set(values, offset - from), from, to);
    return copy;
  }

  get byteLength() {
    return this._chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0);
  }
}

export { F64Snapshot as F64ColSnapshot };

/** Append-only, fixed-size Float64 chunks; old chunks never move as a recording grows. */
export class F64Col extends F64Snapshot {
  revision = 0;

  /** @param {number} [capacity=4096] */
  constructor(capacity = 4096) {
    super([], 0);
    // Capacity is a hint for import, but chunks are allocated only as values arrive.
    void capacity;
  }

  /** @param {number} value */
  push(value) {
    const index = this.length;
    if (index === this._chunks.length * F64_CHUNK_SIZE) this._chunks.push(new Float64Array(F64_CHUNK_SIZE));
    this._chunks[index >>> 12][index & (F64_CHUNK_SIZE - 1)] = value;
    this.length = index + 1;
  }

  /** Allocate a pending chunk before a multi-column row is published. */
  reserveNext() {
    if (this.length === this._chunks.length * F64_CHUNK_SIZE) this._chunks.push(new Float64Array(F64_CHUNK_SIZE));
  }

  /** Replace all values, leaving any prior snapshot intact. @param {ArrayLike<number>} values */
  set(values) {
    /** @type {Float64Array[]} */
    const chunks = [];
    for (let offset = 0; offset < values.length; offset += F64_CHUNK_SIZE) {
      const chunk = new Float64Array(F64_CHUNK_SIZE);
      const stop = Math.min(values.length, offset + F64_CHUNK_SIZE);
      for (let i = offset; i < stop; i++) chunk[i - offset] = values[i];
      chunks.push(chunk);
    }
    this._chunks = chunks;
    this.length = values.length;
    this.revision++;
  }

  /** @param {number} index @param {number} value */
  setAt(index, value) {
    if (index < 0 || index >= this.length) throw new RangeError('Column index out of range');
    const chunkIndex = index >>> 12;
    // Copy on write keeps previously captured snapshots stable.
    const chunk = this._chunks[chunkIndex].slice();
    chunk[index & (F64_CHUNK_SIZE - 1)] = value;
    this._chunks[chunkIndex] = chunk;
    this.revision++;
  }

  /** @returns {F64Snapshot} */
  snapshot() {
    return new F64Snapshot(this._chunks.slice(), this.length);
  }

  /** Compatibility for bounded/cold callers; large calls allocate a contiguous copy. */
  view() {
    return this.copyRange();
  }

  /** Compatibility for old one-chunk callers. */
  get buf() {
    if (this._chunks.length > 1) throw new Error('Multi-chunk column has no contiguous buffer');
    return this._chunks[0] ?? new Float64Array(0);
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
 * @property {F64Col} recordingSegments
 * @property {F64Col} sampleIntervals 每个样本的标称采样间隔（ms），未知为 NaN
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
    recordingSegments: new F64Col(capacity),
    sampleIntervals: new F64Col(capacity),
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
 * @property {{code:string, params:Record<string,string>}} [model_description]
 * @property {{code:string, params:Record<string,string>}} [interface_description]
 * @property {number} interface_number
 * @property {number} usage_page
 * @property {'witrn'|'km003c'} [family] - 设备家族；旧数据缺省按维简处理
 * @property {boolean} [controls] - 是否提供协议控制
 * @property {number} [max_rate_hz] - 最高采样率（次/秒）
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
  theme: 'system',
  language: 'auto',
  windowStyle: 'auto',
  realtimePanelWidth: 250,
  pdSplitSide: false,
  km003cPdm: { pdType: 1, em: 1, sink: 0 },
  recordLimitMb: 512,
  recordingTempSpool: true,
  autoSaveRecording: true,
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
  // WebView2 can keep document.hidden false while its native window is minimized.
  windowVisible: true,
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
  /** @type {boolean} 读数栏分栏拖动中：图表的 ResizeObserver 跳过，松手再定尺。
   *  释放路径为 pointerup / pointercancel / lostpointercapture，处理函数须先清标志再做提交。 */
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
   * 当前数据实际的标称采样间隔（毫秒），不持久化。
   *
   * 能量积分的空档阈值由它推导，所以原生流取设备回报的 rate_ms、导入取 CSV 的
   * SampTime；两者都不知道时为 null，保持绝对 2 秒空档保护。刻意不放进
   * `settings`，导入历史文件才不会改写用户的采样率设置。
   * @type {number|null}
   */
  dataIntervalMs: null,

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
  /** @type {DeviceInfo|null} 当前连接的设备（后端 get_current_device_info） */
  connectedDevice: null,

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
