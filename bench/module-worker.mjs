/** Run the actual browser module Worker in Node, including real structured-clone transfers. */
import { Worker } from 'node:worker_threads';

const host = `
import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };
await import(workerData.url);
parentPort.on('message', data => self.onmessage({data}));
`;

export class ModuleWorker {
  static instances = [];
  constructor(url) {
    this.messages = [];
    this.closed = false;
    this.worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(host)}`), {
      workerData: { url: String(url) },
    });
    this.worker.on('message', (data) => this.onmessage?.({ data }));
    this.worker.on('error', (error) => this.onerror?.({ message: error.message }));
    ModuleWorker.instances.push(this);
  }
  postMessage(message, transfer = []) {
    this.messages.push({
      type: message.type,
      from: message.from,
      rows: message.columns?.x.length,
      entries: message.entries?.length,
      bytes: transfer.reduce((n, buffer) => n + buffer.byteLength, 0),
    });
    this.worker.postMessage(message, transfer);
  }
  terminate() {
    this.closed = true;
    void this.worker.terminate();
  }
}
