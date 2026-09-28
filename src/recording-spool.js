// @ts-check
/**
 * @file 记录实时写入临时恢复文件：每份单次记录（清空或导入之间的全部数据）对应一个缓存文件。
 *
 * - 开始记录时，当前这份数据还没有落盘文件就新建一个，写入定宽表头；已有的行
 *   （例如导入后接着记录）在后台分块补写。
 * - 追加在数据入库路径上按量触发（满 1 秒或满一批行），不靠定时器：窗口最小化时
 *   WebView 会节流定时器，而数据事件照常到达。
 * - 暂停时写完剩余行、原地回写表头并同步到磁盘；清空、导入或正常退出时关闭并删除。
 * - 写入失败会自动暂停记录：数据仍在内存里，可以手动导出。
 *
 * 所有文件操作串在一条队列里，顺序与发生顺序一致。
 */

import { yieldToMainThread } from './cooperative.js';
import {
  formatCsvRange,
  formatSpoolHeader,
  formatSpoolHeaderPatch,
  SPOOL_PATCH_BYTES,
  snapshotCsvColumns,
} from './csv-codec.js';
import { closeWriter, openSpool, patchText, syncFile, writeText } from './file-io.js';
import { state } from './state.js';
import { toast } from './ui/toast.js';

/** 两次追加之间至少隔这么久。 */
const FLUSH_INTERVAL_MS = 1000;
/** 积压到这么多行时不等计时，立即追加。 */
const FLUSH_ROWS = 20_000;
/** 每次写入的行数上限（约 1 MB）。 */
const ROWS_PER_WRITE = 8192;

/**
 * @typedef {Object} Spool
 * @property {number} handle
 * @property {string} path 临时文件路径，仅用于诊断
 * @property {import('./state.js').ChartSeriesColumns} columns 本文件对应的那份数据
 * @property {number} written 已写入的行数
 * @property {number} startTime 表头 DateTime
 */

/** @type {Spool|null} */
let spool = null;
let queue = Promise.resolve();
let lastFlushAt = 0;
let drainQueued = false;
/** @type {(() => void)|null} */
let onFailure = null;

function tempSpoolEnabled() {
  return state.settings.recordingTempSpool !== false && state.settings.autoSaveRecording !== false;
}

/**
 * @param {{ onFailure: () => void }} hooks 落盘失败时暂停记录（由 data.js 注入，避免循环依赖）
 */
export function configureSpool(hooks) {
  onFailure = hooks.onFailure;
}

/** 当前临时文件路径；没有临时文件时为 null。 */
export function spoolPath() {
  return spool?.path ?? null;
}

/** @param {() => Promise<void>} task */
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/** @param {unknown} error */
function fail(error) {
  const failed = spool;
  spool = null;
  drainQueued = false;
  if (failed) void closeWriter(failed.handle).catch(() => {});
  console.error('临时恢复文件写入失败:', error);
  toast.error(`临时恢复文件写入失败：${error}。记录已暂停，数据仍在内存中，可手动导出。`);
  onFailure?.();
}

function stem() {
  const model = (state.connectedDevice?.model_name ?? 'WITRN').replace(/^POWER-Z\s+/, '').replace(/\s+/g, '_');
  const d = new Date();
  /** @param {number} v */
  const pad = (v) => String(v).padStart(2, '0');
  return `${model}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** @param {Spool} target */
function snapshotOf(target) {
  return snapshotCsvColumns(target.columns, {
    withTemp: true,
    // 表头固定带段号列：即使这份数据还没有任何点，也要按同样的列写。
    recordingSegments: target.columns.recordingSegments,
    sampleRate: state.settings.sampleRate,
    startTime: target.startTime,
  });
}

/** 把 [written, 当前长度) 的行写进文件，按块让出主线程。 @param {Spool} target */
async function drain(target) {
  drainQueued = false;
  for (;;) {
    if (spool !== target) return;
    const snapshot = snapshotOf(target);
    if (target.written >= snapshot.length) return;
    const to = Math.min(snapshot.length, target.written + ROWS_PER_WRITE);
    await writeText(target.handle, formatCsvRange(snapshot, target.written, to));
    target.written = to;
    if (to < snapshot.length) await yieldToMainThread();
  }
}

/** 把行数、总时长、采样间隔原地写回表头。 @param {Spool} target */
async function patchHeader(target) {
  const lastX = target.written > 0 ? target.columns.x.valueAt(target.written - 1) : Number.NaN;
  const patch = formatSpoolHeaderPatch({ length: target.written, lastX, sampleRate: state.settings.sampleRate });
  await patchText(target.handle, 0, patch);
}

/** 开始记录：当前这份数据还没有落盘文件时新建一个，并补写已有的行。 */
export function spoolRecordingStarted() {
  if (!tempSpoolEnabled()) return;
  const columns = state.chartSeries;
  if (spool?.columns === columns) return;
  void enqueue(async () => {
    if (spool && spool.columns !== columns) await finish(spool);
    if (spool?.columns === columns || columns !== state.chartSeries || !tempSpoolEnabled()) return;
    const startTime = state.lastRecordingStartTime ?? columns.timestamps.at(0) ?? Date.now();
    const header = formatSpoolHeader({
      length: 0,
      lastX: Number.NaN,
      sampleRate: state.settings.sampleRate,
      startTime,
    });
    const file = await openSpool(stem(), SPOOL_PATCH_BYTES);
    const target = { handle: file.handle, path: file.path, columns, written: 0, startTime };
    spool = target;
    await writeText(target.handle, header);
    lastFlushAt = performance.now();
    await drain(target);
  }).catch(fail);
}

/** 记录了新点：满 1 秒或积压足够多时安排一次追加。 */
export function spoolRowsAppended() {
  const target = spool;
  if (!target || drainQueued) return;
  const now = performance.now();
  if (now - lastFlushAt < FLUSH_INTERVAL_MS && target.columns.x.length - target.written < FLUSH_ROWS) return;
  lastFlushAt = now;
  drainQueued = true;
  void enqueue(() => drain(target)).catch(fail);
}

/**
 * 暂停：写完剩余行、回写表头并同步到磁盘，文件保持打开以便继续记录。
 * 排在队列里执行：刚开始记录就暂停时，文件可能还在打开中。
 */
export function spoolRecordingPaused() {
  return enqueue(async () => {
    const target = spool;
    if (!target) return;
    await drain(target);
    await patchHeader(target);
    await syncFile(target.handle);
  }).catch(fail);
}

/** @param {Spool} target */
async function finish(target) {
  try {
    await drain(target);
    await patchHeader(target);
    // A clean end removes the cache file. If this fails, the backend leaves it in place
    // so the next startup can offer recovery instead of silently losing the data.
    await closeWriter(target.handle, { sync: true, abort: true });
  } finally {
    if (spool === target) spool = null;
  }
}

/**
 * 收尾当前临时文件（清空、导入、关闭临时恢复或退出时）。
 * 返回的 Promise 在文件关闭后完成，失败时同样提示并暂停记录。
 */
export function finalizeSpool() {
  return enqueue(async () => {
    if (spool) await finish(spool);
  }).catch(fail);
}
