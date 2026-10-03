// @ts-check
import { foldRangeStatsChunk } from './range-stats.js';

const worker = /** @type {any} */ (self);
/** @type {import('./range-stats.js').RangeStats|null} */
let stats = null;
worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const message = event.data;
  try {
    if (message.type === 'begin') stats = message.stats;
    else if (message.type === 'chunk') {
      if (!stats) throw new Error('范围统计尚未开始');
      foldRangeStatsChunk(stats, message.from, message.columns, message.previousX, message.previousSegment);
    } else if (message.type === 'end') {
      worker.postMessage({ type: 'result', stats });
      stats = null;
      return;
    }
    worker.postMessage({ type: 'ack' });
  } catch (error) {
    stats = null;
    worker.postMessage({ type: 'error', error: String(error) });
  }
};
