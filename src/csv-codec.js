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
 * @property {Record<ColumnKey, Float64Array>} columns 固定长度的原 buf 视图，不复制、不 detach
 * @property {number} length
 * @property {number} sampleRate
 * @property {number} startTime
 * @property {boolean} withTemp
 * @property {Float64Array|null} recordingSegments
 */

/**
 * 必须在 save 返回路径后、首次让出线程前调用。录制只追加，扩容 / 清空替换 buf
 * 不会影响这些旧视图；调用方不得原位改写快照范围内的历史点。
 * RecordingSegment 接入：只传真实、逐点对齐的段编号 F64Col；未知点用 NaN。
 * 段列由 ingest 逐点写入（每次录制段递增、预览/暂停边界不猜测），此处不重新推断段号，
 * 也不为缺失段元数据的旧文件生成 0。
 * @param {import('./state.js').ChartSeriesColumns} columns
 * @param {{sampleRate: number, startTime: number, withTemp?: boolean, recordingSegments?: F64Col|null}} options
 * @returns {CsvSnapshot}
 */
export function snapshotCsvColumns(columns, options) {
  const length = columns.x.length;
  const views = /** @type {Record<ColumnKey, Float64Array>} */ ({});
  for (const key of COLUMN_KEYS) {
    const col = columns[key];
    views[key] = col.buf.subarray(0, Math.min(length, col.length));
  }
  const segments = options.recordingSegments ?? (columns.recordingSegments.length ? columns.recordingSegments : null);
  return {
    columns: views,
    length,
    sampleRate: options.sampleRate,
    startTime: options.startTime,
    withTemp: options.withTemp ?? false,
    recordingSegments: segments ? segments.buf.subarray(0, Math.min(length, segments.length)) : null,
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

/**
 * 每次仅保留一个小块字符串。原有前置列不移动，精确时间和可选段号只在尾部追加。
 * @param {CsvSnapshot} snapshot
 * @param {number} [chunkRows=CSV_CHUNK_ROWS]
 */
export function* formatCsvChunks(snapshot, chunkRows = CSV_CHUNK_ROWS) {
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1) throw new RangeError('Invalid CSV chunk size');
  const { columns: c, length, withTemp, recordingSegments } = snapshot;
  const d = new Date(snapshot.startTime);
  /** @param {number} value */
  const pad = (value) => String(value).padStart(2, '0');
  const dateTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const header = `${TIME_HEADER},Voltage(V),Current(A),Power(W),${withTemp ? 'Temp(°C),' : ''}D+(V),D-(V),CC1(V),CC2(V),RelativeTime(s),Timestamp(ms)${recordingSegments ? ',RecordingSegment' : ''},`;
  yield `SUM,${length}\nTotalTime,${formatExcelTime(c.x[length - 1])}\nSampTime(ms),${numericCell(snapshot.sampleRate)}\nDateTime,${dateTime}\n\n${header}\n`;

  for (let from = 0; from < length; from += chunkRows) {
    const to = Math.min(length, from + chunkRows);
    const lines = new Array(to - from);
    for (let i = from; i < to; i++) {
      const signals = `${numericCell(c.dp[i])},${numericCell(c.dn[i])},${numericCell(c.cc1[i])},${numericCell(c.cc2[i])}`;
      lines[i - from] =
        `${formatExcelTime(c.x[i])},${numericCell(c.voltage[i])},${numericCell(c.current[i])},${numericCell(c.power[i])},${withTemp ? `${numericCell(c.temp[i])},` : ''}${signals},${numericCell(c.x[i])},${numericCell(c.timestamps[i])}${recordingSegments ? `,${numericCell(recordingSegments[i])}` : ''},`;
    }
    yield `${lines.join('\n')}\n`;
  }
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

/** @param {string} content @param {number} [start=0] */
function* scanLines(content, start = 0) {
  while (start < content.length) {
    const end = content.indexOf('\n', start);
    const next = end === -1 ? content.length : end + 1;
    // trim 同时处理 BOM、CRLF 和旧导入允许的行首尾空白，不保留整份行数组。
    const text = content.slice(start, end === -1 ? content.length : end).trim();
    yield { text, next };
    start = next;
  }
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
 * @param {F64Col|null} segments
 */
function stableSortColumns(columns, segments) {
  const n = columns.x.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const x = columns.x.buf;
  order.sort((a, b) => x[a] - x[b] || a - b);
  const scratch = new Float64Array(n);
  /** @param {F64Col} column */
  const reorder = (column) => {
    for (let i = 0; i < n; i++) scratch[i] = column.buf[order[i]];
    column.buf.set(scratch);
  };
  for (const key of COLUMN_KEYS) reorder(columns[key]);
  if (segments) reorder(segments);
}

/**
 * 两次轻量行扫描：先确定表头、DateTime 和容量（不信任 SUM），再直接填临时 F64。
 * 没有整文件 split、十组普通数组或提交前的二次整列复制，也不改动原始记录。
 * RecordingSegment 返回独立可选列，缺失为 null，未知点 NaN；导入侧把该列与 cols 一起
 * 提交并交给 calculateEnergyInRange 做分段积分，缺失段元数据的旧文件回落原有能量规则。
 * intervalMs 是文件的标称采样间隔：优先取摘要行的 SampTime(ms)，旧文件没有该行时从
 * 相对秒序列反推，两者都拿不到则为 null（能量空档阈值回落到绝对 2 秒）。
 * @param {string} content
 * @param {{signedCurrent?: boolean, fallbackStartTime: number}} options
 */
export function parseCsv(content, options) {
  let header = '';
  let dataStart = -1;
  let capacity = 0;
  let foundDate = false;
  let startTime = options.fallbackStartTime;
  /** 文件自己声明的采样间隔；旧文件没有这一行时由 x 序列反推。 */
  let declaredIntervalMs = null;
  for (const { text, next } of scanLines(content)) {
    if (!foundDate && text.startsWith('DateTime,')) {
      foundDate = true;
      startTime = parseCsvDateTime(text.split(',')[1]) ?? startTime;
    }
    if (declaredIntervalMs === null && text.startsWith(SAMP_TIME_HEADER)) {
      const declared = Number.parseFloat(text.slice(SAMP_TIME_HEADER.length));
      if (Number.isFinite(declared) && declared >= 10 && declared <= 60000) declaredIntervalMs = declared;
    }
    if (dataStart === -1 && text.startsWith(TIME_HEADER)) {
      header = text;
      dataStart = next;
    } else if (dataStart !== -1 && text) {
      capacity++;
    }
  }
  if (dataStart === -1) throw new Error('Invalid CSV format: Header not found');
  const map = mapCsvColumns(header);
  const headers = header.split(',').map((text) => text.trim());
  const relativeIndex = headers.indexOf('RelativeTime(s)');
  const timestampIndex = headers.indexOf('Timestamp(ms)');
  const segmentIndex = headers.indexOf('RecordingSegment');
  const precise = relativeIndex !== -1 && timestampIndex !== -1;
  const columns = emptyChartColumns(capacity);
  const recordingSegments = segmentIndex === -1 ? null : columns.recordingSegments;
  const readCell = precise ? exactCell : optionalCell;
  let sorted = true;
  let previous = -Infinity;
  for (const { text } of scanLines(content, dataStart)) {
    if (!text) continue;
    const parts = text.split(',');
    if (parts.length < 4) continue;
    const voltage = precise ? exactCell(parts, 1) : Number.parseFloat(parts[1]);
    const rawCurrent = precise ? exactCell(parts, 2) : Number.parseFloat(parts[2]);
    const current = precise || options.signedCurrent ? rawCurrent : Math.abs(rawCurrent);
    const power = precise ? exactCell(parts, 3) : Math.abs(Number.parseFloat(parts[3]));
    if (!precise && (Number.isNaN(voltage) || Number.isNaN(current) || Number.isNaN(power))) continue;
    const exactSeconds = exactCell(parts, relativeIndex);
    const seconds = Number.isFinite(exactSeconds) ? exactSeconds : parseRelativeTime(parts[0]);
    if (seconds === null) continue;
    const timestamp = exactCell(parts, timestampIndex);
    columns.x.push(seconds);
    columns.timestamps.push(Number.isFinite(timestamp) ? timestamp : startTime + seconds * 1000);
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
  if (columns.x.length === 0) throw new Error('No valid data found in CSV');
  if (!sorted) stableSortColumns(columns, recordingSegments);
  const intervalMs = declaredIntervalMs ?? estimateIntervalMsFromX(columns.x.buf);
  return { columns, startTime, recordingSegments, intervalMs };
}
