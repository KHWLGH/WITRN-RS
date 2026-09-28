// @ts-check
/**
 * @file 无 DOM / Tauri / 全局 state 读写的 CSV codec。
 * 复用列容器和 measurement 的旧格式规则，不创建 Worker 或转移 ArrayBuffer。
 */

import { estimateIntervalMsFromX, mapCsvColumns, parseRelativeTime } from './measurement.js';
import { emptyChartColumns, F64Col } from './state.js';

/** @typedef {'x'|'timestamps'|'voltage'|'current'|'power'|'temp'|'dp'|'dn'|'cc1'|'cc2'} ColumnKey */
/** @type {ColumnKey[]} */
const COLUMN_KEYS = ['x', 'timestamps', 'voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];
const TIME_HEADER = 'Time(D.hh:mm:ss.ms)';
/** 摘要行里声明采样间隔的前缀，导入时用它决定能量积分的空档阈值。 */
const SAMP_TIME_HEADER = 'SampTime(ms),';
export const CSV_CHUNK_ROWS = 1024;

/**
 * @typedef {Object} CsvSnapshot
 * @property {Record<ColumnKey, import('./state.js').F64Snapshot>} columns 固定长度快照
 * @property {number} length
 * @property {number} sampleRate
 * @property {number} startTime
 * @property {boolean} withTemp
 * @property {import('./state.js').F64Snapshot|null} recordingSegments
 */

/**
 * 必须在 save 返回路径后、首次让出线程前调用。录制只追加；快照固定长度与块引用。
 * 调用方不得原位改写快照范围内的历史点。
 * RecordingSegment 接入：只传真实、逐点对齐的段编号 F64Col；未知点用 NaN。
 * 段列由 ingest 逐点写入（每次录制段递增、预览/暂停边界不猜测），此处不重新推断段号，
 * 也不为缺失段元数据的旧文件生成 0。
 * @param {import('./state.js').ChartSeriesColumns} columns
 * @param {{sampleRate: number, startTime: number, withTemp?: boolean, recordingSegments?: F64Col|null}} options
 * @returns {CsvSnapshot}
 */
export function snapshotCsvColumns(columns, options) {
  const length = columns.x.length;
  const views = /** @type {Record<ColumnKey, import('./state.js').F64Snapshot>} */ ({});
  for (const key of COLUMN_KEYS) {
    const col = columns[key];
    views[key] = col.snapshot();
  }
  const segments = options.recordingSegments ?? (columns.recordingSegments.length ? columns.recordingSegments : null);
  return {
    columns: views,
    length,
    sampleRate: options.sampleRate,
    startTime: options.startTime,
    withTemp: options.withTemp ?? false,
    recordingSegments: segments ? segments.snapshot() : null,
  };
}

/** 有限 Number 使用最短可往返十进制；缺失值留空，保留 -0。 @param {number} value */
function numericCell(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? (Object.is(value, -0) ? '-0' : String(value)) : '';
}

/** 保持首列的旧 Excel 显示格式；精确相对秒由尾列承载。 @param {number} seconds */
export function formatExcelTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const day = Math.floor(safe / 86400);
  const rem = safe - day * 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = Math.floor(rem % 60);
  const ms = Math.floor((rem % 1) * 1000);
  const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  return day > 0 ? `="${day}.${hms}"` : `="${hms}"`;
}

/** 数据区列标题。温度列与段号列可选，其余列位置固定。 @param {boolean} withTemp @param {boolean} withSegments */
function columnHeader(withTemp, withSegments) {
  return `${TIME_HEADER},Voltage(V),Current(A),Power(W),${withTemp ? 'Temp(°C),' : ''}D+(V),D-(V),CC1(V),CC2(V),RelativeTime(s),Timestamp(ms)${withSegments ? ',RecordingSegment' : ''},`;
}

/** 本地时间的 `YYYY-MM-DD HH:MM:SS`。 @param {number} ms */
function formatDateTime(ms) {
  const d = new Date(ms);
  /** @param {number} value */
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * [from, to) 行的数据文本，每行以换行结束。行格式与 {@link formatCsvChunks} 完全一致。
 * @param {CsvSnapshot} snapshot
 * @param {number} from
 * @param {number} to
 */
export function formatCsvRange(snapshot, from, to) {
  const { columns: c, withTemp, recordingSegments } = snapshot;
  const start = Math.max(0, Math.min(snapshot.length, from));
  const end = Math.max(start, Math.min(snapshot.length, to));
  if (end === start) return '';
  const lines = new Array(end - start);
  for (let i = start; i < end; i++) {
    const signals = `${numericCell(c.dp.valueAt(i))},${numericCell(c.dn.valueAt(i))},${numericCell(c.cc1.valueAt(i))},${numericCell(c.cc2.valueAt(i))}`;
    lines[i - start] =
      `${formatExcelTime(c.x.valueAt(i))},${numericCell(c.voltage.valueAt(i))},${numericCell(c.current.valueAt(i))},${numericCell(c.power.valueAt(i))},${withTemp ? `${numericCell(c.temp.valueAt(i))},` : ''}${signals},${numericCell(c.x.valueAt(i))},${numericCell(c.timestamps.valueAt(i))}${recordingSegments ? `,${numericCell(recordingSegments.valueAt(i))}` : ''},`;
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 每次仅保留一个小块字符串。原有前置列不移动，精确时间和可选段号只在尾部追加。
 * @param {CsvSnapshot} snapshot
 * @param {number} [chunkRows=CSV_CHUNK_ROWS]
 */
export function* formatCsvChunks(snapshot, chunkRows = CSV_CHUNK_ROWS) {
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1) throw new RangeError('Invalid CSV chunk size');
  const { columns: c, length, withTemp, recordingSegments } = snapshot;
  const header = columnHeader(withTemp, !!recordingSegments);
  yield `SUM,${length}\nTotalTime,${formatExcelTime(c.x.at(-1))}\nSampTime(ms),${numericCell(snapshot.sampleRate)}\nDateTime,${formatDateTime(snapshot.startTime)}\n\n${header}\n`;

  for (let from = 0; from < length; from += chunkRows) {
    yield formatCsvRange(snapshot, from, Math.min(length, from + chunkRows));
  }
}

/** 落盘总时长：天数补到 4 位，任何时长都是同一个字节长度。 @param {number} seconds */
function formatSpoolTotalTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 9999 * 86400) : 0;
  const day = Math.floor(safe / 86400);
  const rem = safe - day * 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = Math.floor(rem % 60);
  const ms = Math.floor((rem % 1) * 1000);
  return `="${String(day).padStart(4, '0')}.${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}"`;
}

/**
 * @typedef {Object} SpoolSummary
 * @property {number} length 已写入的行数
 * @property {number} lastX 最后一行的相对秒；没有行时 NaN
 * @property {number} sampleRate 标称采样间隔（毫秒）
 */

/**
 * 落盘表头里可回写的前三行：行数、总时长、采样间隔，全部定宽。
 * 落盘文件边录边追加，写表头时还不知道最终值，停下时按同样宽度原地覆盖。
 * @param {SpoolSummary} summary
 */
export function formatSpoolHeaderPatch(summary) {
  const rows = Math.max(0, Math.min(999_999_999_999, Math.floor(summary.length)));
  const rate = Math.max(0, Math.min(999_999, Math.round(summary.sampleRate)));
  return `SUM,${String(rows).padStart(12, '0')}\nTotalTime,${formatSpoolTotalTime(summary.lastX)}\nSampTime(ms),${String(rate).padStart(6, '0')}\n`;
}

/** 可回写区域的字节数（全是 ASCII，字符数即字节数）。 */
export const SPOOL_PATCH_BYTES = formatSpoolHeaderPatch({ length: 0, lastX: 0, sampleRate: 0 }).length;

/**
 * 落盘文件的完整表头。列固定带温度与段号：落盘开始时还不知道之后会不会用到它们。
 * @param {SpoolSummary & { startTime: number }} summary
 */
export function formatSpoolHeader(summary) {
  return `${formatSpoolHeaderPatch(summary)}DateTime,${formatDateTime(summary.startTime)}\n\n${columnHeader(true, true)}\n`;
}

/**
 * 显式解析本地年月日与时分秒，避免 Safari 的非标准 Date 字符串解析。
 * 兼容旧文件的横线 / 斜线分隔，以及可选的毫秒；无效日期交给调用方回退。
 * @param {string} text
 * @returns {number|null}
 */
export function parseCsvDateTime(text) {
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[3]) - 1;
  const day = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  const ms = Number((match[8] || '').padEnd(3, '0'));
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(hour, minute, second, ms);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  )
    return null;
  return date.getTime();
}

/** 旧可选列使用 parseFloat，非有限 / 空值保持 NaN。 @param {string[]} parts @param {number} index */
function optionalCell(parts, index) {
  const value = index < 0 || index >= parts.length ? Number.NaN : Number.parseFloat(parts[index]);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** 新精确列不接受带单位的残缺数值；空白不能变成 0。 @param {string[]} parts @param {number} index */
function exactCell(parts, index) {
  const text = index < 0 || index >= parts.length ? '' : parts[index].trim();
  return text ? Number(text) : Number.NaN;
}

/**
 * 临时 F64 列内重排：仅乱序文件分配索引和一个共用的 F64 scratch，等时点保持原顺序。
 * @param {import('./state.js').ChartSeriesColumns} columns
 */
function stableSortColumns(columns) {
  const n = columns.x.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const x = columns.x;
  order.sort((a, b) => x.valueAt(a) - x.valueAt(b) || a - b);
  for (const key of /** @type {(keyof import('./state.js').ChartSeriesColumns)[]} */ ([
    ...COLUMN_KEYS,
    'recordingSegments',
  ])) {
    const old = columns[key];
    const sorted = new F64Col();
    for (let i = 0; i < n; i++) sorted.push(old.valueAt(order[i]));
    columns[key] = sorted;
  }
}

/** 超过这个长度仍没有换行，就不是本应用能读的 CSV（多半选错了文件）。 */
const MAX_LINE_CHARS = 1 << 20;

/**
 * 流式 CSV 解析器：文本可以按任意位置切块喂入，结果与整份解析逐位相同。
 *
 * 只扫一遍：元数据按行识别，表头之后的行按数据解析。旧文件的 DateTime 可能写在数据之后，
 * 在它出现之前缺时间戳的行先占位，`finish` 时用最终的起点一次性补齐。
 * 本应用写出的精确格式每行以逗号结尾，文件末尾没有换行、也不以逗号结尾的那一行视为
 * 被截断（异常退出时的落盘文件）并丢弃；只要之前有一行不以逗号结尾，这条规则就不生效。
 * RecordingSegment 返回独立可选列，缺失为 null，未知点 NaN。
 * intervalMs 是文件的标称采样间隔：优先取摘要行的 SampTime(ms)，没有时从相对秒序列
 * 反推，两者都拿不到则为 null（能量空档阈值回落到绝对 2 秒）。
 * @param {{signedCurrent?: boolean, fallbackStartTime: number}} options
 */
export function createCsvParser(options) {
  let carry = '';
  let headerFound = false;
  let foundDate = false;
  let startTime = options.fallbackStartTime;
  /** 文件自己声明的采样间隔；旧文件没有这一行时由 x 序列反推。 */
  /** @type {number|null} */
  let declaredIntervalMs = null;
  /** @type {ReturnType<typeof mapCsvColumns>} */
  let map = mapCsvColumns('');
  let relativeIndex = -1;
  let timestampIndex = -1;
  let segmentIndex = -1;
  let precise = false;
  let readCell = optionalCell;
  const columns = emptyChartColumns();
  let sorted = true;
  let previous = -Infinity;
  let timestampsPending = false;
  let rowsEndWithComma = true;

  /** @param {string} text */
  function acceptHeader(text) {
    headerFound = true;
    map = mapCsvColumns(text);
    const headers = text.split(',').map((cell) => cell.trim());
    relativeIndex = headers.indexOf('RelativeTime(s)');
    timestampIndex = headers.indexOf('Timestamp(ms)');
    segmentIndex = headers.indexOf('RecordingSegment');
    precise = relativeIndex !== -1 && timestampIndex !== -1;
    readCell = precise ? exactCell : optionalCell;
  }

  /** @param {string} text */
  function dataRow(text) {
    const parts = text.split(',');
    if (parts.length < 4) return;
    const voltage = precise ? exactCell(parts, 1) : Number.parseFloat(parts[1]);
    const rawCurrent = precise ? exactCell(parts, 2) : Number.parseFloat(parts[2]);
    const current = precise || options.signedCurrent ? rawCurrent : Math.abs(rawCurrent);
    const power = precise ? exactCell(parts, 3) : Math.abs(Number.parseFloat(parts[3]));
    if (!precise && (Number.isNaN(voltage) || Number.isNaN(current) || Number.isNaN(power))) return;
    const exactSeconds = exactCell(parts, relativeIndex);
    const seconds = Number.isFinite(exactSeconds) ? exactSeconds : parseRelativeTime(parts[0]);
    if (seconds === null) return;
    let timestamp = exactCell(parts, timestampIndex);
    if (!Number.isFinite(timestamp)) {
      // DateTime 在后面才出现时起点未定：先占位，finish 统一补。
      if (foundDate) timestamp = startTime + seconds * 1000;
      else {
        timestamp = Number.NaN;
        timestampsPending = true;
      }
    }
    if (!text.endsWith(',')) rowsEndWithComma = false;
    columns.x.push(seconds);
    columns.timestamps.push(timestamp);
    columns.voltage.push(voltage);
    columns.current.push(current);
    columns.power.push(power);
    columns.temp.push(readCell(parts, map.tempIdx));
    columns.dp.push(readCell(parts, map.dpIdx));
    columns.dn.push(readCell(parts, map.dnIdx));
    columns.cc1.push(readCell(parts, map.cc1Idx));
    columns.cc2.push(readCell(parts, map.cc2Idx));
    columns.recordingSegments.push(exactCell(parts, segmentIndex));
    if (seconds < previous) sorted = false;
    previous = seconds;
  }

  /** @param {string} raw @param {boolean} last */
  function line(raw, last) {
    // trim handles BOM, CRLF, and legacy leading/trailing whitespace.
    const text = raw.trim();
    if (!text) return;
    const first = text.charCodeAt(0);
    if (first === 68 && !foundDate && text.startsWith('DateTime,')) {
      foundDate = true;
      startTime = parseCsvDateTime(text.split(',')[1]) ?? startTime;
      return;
    }
    if (first === 83 && declaredIntervalMs === null && text.startsWith(SAMP_TIME_HEADER)) {
      const declared = Number.parseFloat(text.slice(SAMP_TIME_HEADER.length));
      if (Number.isFinite(declared) && declared >= 1 && declared <= 60000) declaredIntervalMs = declared;
      return;
    }
    if (!headerFound) {
      if (text.startsWith(TIME_HEADER)) acceptHeader(text);
      return;
    }
    if (last && precise && rowsEndWithComma && columns.x.length > 0 && !text.endsWith(',')) return;
    dataRow(text);
  }

  return {
    /** @param {string} chunk */
    push(chunk) {
      const text = carry ? carry + chunk : chunk;
      let start = 0;
      for (;;) {
        const end = text.indexOf('\n', start);
        if (end === -1) break;
        line(text.slice(start, end), false);
        start = end + 1;
      }
      carry = start === 0 ? text : text.slice(start);
      if (carry.length > MAX_LINE_CHARS) throw new Error('CSV 行过长，不是有效的记录文件');
    },
    /** 已解析的数据行数。 */
    get rows() {
      return columns.x.length;
    },
    finish() {
      if (carry) line(carry, true);
      carry = '';
      if (!headerFound) throw new Error('Invalid CSV format: Header not found');
      if (columns.x.length === 0) throw new Error('No valid data found in CSV');
      if (timestampsPending) {
        const filled = new F64Col();
        const n = columns.x.length;
        for (let i = 0; i < n; i++) {
          const value = columns.timestamps.valueAt(i);
          filled.push(Number.isNaN(value) ? startTime + columns.x.valueAt(i) * 1000 : value);
        }
        columns.timestamps = filled;
      }
      if (!sorted) stableSortColumns(columns);
      const intervalMs = declaredIntervalMs ?? estimateIntervalMsFromX(columns.x);
      return {
        columns,
        startTime,
        recordingSegments: segmentIndex === -1 ? null : columns.recordingSegments,
        intervalMs,
      };
    },
  };
}

/**
 * 整份文本的解析，等价于把全文一次喂给 {@link createCsvParser}。
 * @param {string} content
 * @param {{signedCurrent?: boolean, fallbackStartTime: number}} options
 */
export function parseCsv(content, options) {
  const parser = createCsvParser(options);
  parser.push(content);
  return parser.finish();
}
