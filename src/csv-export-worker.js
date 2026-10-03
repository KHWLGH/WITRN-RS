// @ts-check
import { formatCsvRange } from './csv-codec.js';

/** @typedef {{valueAt:(index:number)=>number, at:(index:number)=>number}} WorkerColumn */

const worker = /** @type {any} */ (self);
worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const message = event.data;
  try {
    /** @type {Record<string, WorkerColumn>} */
    const columns = {};
    for (const [key, values] of Object.entries(message.columns ?? {})) {
      columns[key] = { valueAt: (i) => values[i], at: (i) => values[i] };
    }
    /** @type {WorkerColumn|null} */
    const segments = message.recordingSegments
      ? { valueAt: (i) => message.recordingSegments[i], at: (i) => message.recordingSegments[i] }
      : null;
    const snapshot = /** @type {import('./csv-codec.js').CsvSnapshot} */ ({
      columns,
      length: message.length,
      sampleRate: 0,
      startTime: 0,
      withTemp: !!message.withTemp,
      recordingSegments: segments,
    });
    const text = formatCsvRange(snapshot, 0, message.length);
    worker.postMessage({ type: 'result', id: message.id, text });
  } catch (error) {
    worker.postMessage({
      type: 'error',
      id: message?.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
