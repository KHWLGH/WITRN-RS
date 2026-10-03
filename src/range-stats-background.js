// @ts-check
import { computeRangeStatsAsync, initialStats } from './range-stats.js';

/**
 * Transfer bounded copies, never the source buffers; fallback preserves ordered arithmetic.
 * @param {import('./range-stats.js').RangeStatsSnapshot} snapshot
 * @param {import('./range-stats.js').FoldOptions & {isCancelled:()=>boolean,signal:AbortSignal}} options
 * @returns {Promise<import('./range-stats.js').RangeStats|null>}
 */
export async function computeRangeStatsBackground(snapshot, options) {
  if (typeof Worker === 'undefined') return computeRangeStatsAsync(snapshot, options);
  /** @type {Worker|null} */
  let worker = null;
  /** @type {((error:Error)=>void)|null} */
  let rejectPending = null;
  const abort = () => {
    worker?.terminate();
    rejectPending?.(new Error('范围统计已取消'));
  };
  try {
    if (options.isCancelled() || options.signal.aborted) return null;
    worker = new Worker(new URL('./range-stats-worker.js', import.meta.url), { type: 'module' });
    options.signal.addEventListener('abort', abort, { once: true });
    /** @type {((reply:any)=>void)|null} */
    let resolvePending = null;
    worker.onmessage = (event) => {
      if (event.data?.type === 'error') rejectPending?.(new Error(event.data.error));
      else resolvePending?.(event.data);
      resolvePending = null;
      rejectPending = null;
    };
    worker.onerror = (event) => rejectPending?.(new Error(event.message || '范围统计 Worker 失败'));
    worker.onmessageerror = () => rejectPending?.(new Error('范围统计数据传输失败'));
    /** @param {unknown} message @param {Transferable[]} [transfer] */
    const send = (message, transfer = []) =>
      new Promise((resolve, reject) => {
        if (options.isCancelled() || options.signal.aborted) {
          reject(new Error('范围统计已取消'));
          return;
        }
        resolvePending = resolve;
        rejectPending = reject;
        worker?.postMessage(message, transfer);
      });
    const { columns: _source, ...stats } = initialStats(snapshot, options.seed ?? null);
    await send({ type: 'begin', stats });
    const keys = /** @type {const} */ ([
      'x',
      'voltage',
      'current',
      'power',
      'temp',
      'recordingSegments',
      'sampleIntervals',
    ]);
    for (let from = options.foldStart ?? snapshot.startIndex; from <= snapshot.endIndex; from += 4096) {
      if (options.isCancelled() || options.signal.aborted) return null;
      const to = Math.min(snapshot.endIndex + 1, from + 4096);
      const columns = {};
      const transfer = [];
      for (const key of keys) {
        const values = snapshot[key].copyRange(from, to);
        columns[key] = values;
        transfer.push(values.buffer);
      }
      await send(
        {
          type: 'chunk',
          from,
          columns,
          previousX: snapshot.x.valueAt(from - 1),
          previousSegment: snapshot.recordingSegments.valueAt(from - 1),
        },
        transfer,
      );
    }
    const reply = /** @type {any} */ (await send({ type: 'end' }));
    if (options.isCancelled() || options.signal.aborted) return null;
    if (reply.type !== 'result' || !reply.stats) throw new Error('范围统计 Worker 返回无效数据');
    return { ...reply.stats, columns: snapshot.columns };
  } catch (error) {
    if (options.isCancelled() || options.signal.aborted) return null;
    console.warn('范围统计 Worker 不可用，使用协作分片:', error);
    return computeRangeStatsAsync(snapshot, options);
  } finally {
    options.signal.removeEventListener('abort', abort);
    worker?.terminate();
  }
}
