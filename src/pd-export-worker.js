// @ts-check
import { encodePdEntries, encodePdText, pdCapturePrefix } from './pd-export-core.js';

const worker = /** @type {any} */ (self);
/** @type {Generator<Uint8Array>|null} */
let chunks = null;
worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const message = event.data;
  try {
    if (message.type === 'begin') chunks = encodePdText(pdCapturePrefix(message.exportedAt));
    else if (message.type === 'entries') chunks = encodePdEntries(message.entries, message.first);
    else if (message.type === 'end') chunks = encodePdText(']}');
    const next = chunks?.next();
    if (!next || next.done) {
      chunks = null;
      worker.postMessage({ type: 'ack' });
    } else worker.postMessage({ type: 'chunk', bytes: next.value }, [next.value.buffer]);
  } catch (error) {
    chunks = null;
    worker.postMessage({ type: 'error', error: String(error) });
  }
};
