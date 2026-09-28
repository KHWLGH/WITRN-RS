// @ts-check
/**
 * CSV import Worker. The main thread streams the file in byte slices:
 * `begin` → `chunk`* → `end`; every chunk is acknowledged before the next is read, so
 * neither thread ever holds the whole file.
 */
import { createCsvImport } from './csv-import-core.js';

const worker = /** @type {any} */ (self);
/** @type {ReturnType<typeof createCsvImport>|null} */
let session = null;
/** @type {TextDecoder|null} */
let decoder = null;

worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const message = event.data;
  try {
    if (message?.type === 'begin') {
      session = createCsvImport(message.options);
      decoder = new TextDecoder('utf-8');
      worker.postMessage({ type: 'ready' });
    } else if (message?.type === 'chunk') {
      if (!session || !decoder) throw new Error('CSV 导入尚未开始');
      session.push(decoder.decode(new Uint8Array(message.bytes), { stream: true }));
      worker.postMessage({ type: 'ack', rows: session.rows });
    } else if (message?.type === 'end') {
      if (!session || !decoder) throw new Error('CSV 导入尚未开始');
      session.push(decoder.decode());
      const result = session.finish();
      session = null;
      decoder = null;
      // Every chunk was allocated while parsing this file in this Worker.
      const transfer = Object.values(result.columns).flatMap((column) =>
        column._chunks.map((/** @type {Float64Array} */ chunk) => chunk.buffer),
      );
      worker.postMessage({ type: 'done', result }, transfer);
    }
  } catch (error) {
    session = null;
    decoder = null;
    worker.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
