// @ts-check
/** Bounded CSV formatting bridge. The main thread copies one range, then waits for the Worker. */

import { formatCsvRange } from './csv-codec.js';

/** @type {Worker|null} */
let worker = null;
let nextId = 0;
/** @type {Map<number, {resolve:(value:string)=>void,reject:(error:Error)=>void}>} */
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  worker = new Worker(new URL('./csv-export-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const message = event.data;
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.type === 'result') waiter.resolve(message.text);
    else waiter.reject(new Error(message.error || 'CSV export Worker failed'));
  };
  worker.onerror = (event) => {
    failWorker(new Error(event.message || 'CSV export Worker failed'));
  };
  worker.onmessageerror = () => {
    failWorker(new Error('CSV export Worker data transfer failed'));
  };
  return worker;
}

/** End a broken Worker instance and settle every request sent to it. @param {Error} error */
function failWorker(error) {
  const broken = worker;
  worker = null;
  broken?.terminate();
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

/** @param {import('./csv-codec.js').CsvSnapshot} snapshot @param {number} from @param {number} to */
export function formatCsvRangeAsync(snapshot, from, to) {
  const current = getWorker();
  if (!current) return Promise.resolve(formatCsvRange(snapshot, from, to));
  const keys = ['x', 'timestamps', 'voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2', 'sampleIntervals'];
  /** @type {Record<string, Float64Array>} */
  const columns = {};
  const transfer = [];
  for (const key of keys) {
    const values = snapshot.columns[key].copyRange(from, to);
    columns[key] = values;
    transfer.push(values.buffer);
  }
  let segments = null;
  if (snapshot.recordingSegments) {
    segments = snapshot.recordingSegments.copyRange(from, to);
    transfer.push(segments.buffer);
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      current.postMessage(
        {
          id,
          from,
          to,
          length: to - from,
          columns,
          recordingSegments: segments,
          withTemp: snapshot.withTemp,
        },
        transfer,
      );
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function terminateCsvExportWorker() {
  failWorker(new Error('CSV export cancelled'));
}
