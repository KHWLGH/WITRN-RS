// @ts-check
import { closeWriter, pickPdExportFile, writeBytes } from './file-io.js';
import { PD_EXPORT_BATCH } from './pd-export-core.js';

/** @type {Promise<number|null>|null} */
let active = null;
/** @type {(() => void)|null} */
let cancelActive = null;

/** Freeze after the native save dialog; every write acknowledges one bounded Worker chunk.
 * @param {() => (import('./pd-model.js').PdEntry|import('./pd-model.js').PdDivider)[]} getEntries
 * @returns {Promise<number|null>}
 */
export function exportPdFile(getEntries) {
  if (active) return active;
  active = runExport(getEntries).finally(() => {
    active = null;
    cancelActive = null;
  });
  return active;
}

/** @param {() => (import('./pd-model.js').PdEntry|import('./pd-model.js').PdDivider)[]} getEntries */
async function runExport(getEntries) {
  let cancelled = false;
  /** @type {Worker|null} */
  let worker = null;
  /** @type {((error:Error) => void)|null} */
  let rejectPending = null;
  cancelActive = () => {
    cancelled = true;
    worker?.terminate();
    rejectPending?.(new Error('PD 导出已取消'));
  };
  const file = await pickPdExportFile(`lapower_pd_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  if (!file) return null;
  try {
    if (cancelled) throw new Error('PD 导出已取消');
    const entries = getEntries().slice();
    const exportedAt = new Date().toISOString();
    worker = new Worker(new URL('./pd-export-worker.js', import.meta.url), { type: 'module' });
    /** @type {((message:any) => void)|null} */
    let resolvePending = null;
    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'error') rejectPending?.(new Error(message.error));
      else resolvePending?.(message);
      rejectPending = null;
      resolvePending = null;
    };
    worker.onerror = (event) => rejectPending?.(new Error(event.message || 'PD 导出 Worker 失败'));
    worker.onmessageerror = () => rejectPending?.(new Error('PD 导出数据传输失败'));
    /** @param {unknown} message */
    const send = (message) =>
      new Promise((resolve, reject) => {
        if (cancelled) {
          reject(new Error('PD 导出已取消'));
          return;
        }
        resolvePending = resolve;
        rejectPending = reject;
        worker?.postMessage(message);
      });
    /** @param {unknown} message */
    const drain = async (message) => {
      let reply = /** @type {any} */ (await send(message));
      while (reply.type === 'chunk') {
        if (cancelled) throw new Error('PD 导出已取消');
        await writeBytes(file.handle, reply.bytes);
        reply = await send({ type: 'pull' });
      }
      if (reply.type !== 'ack') throw new Error('PD 导出 Worker 返回无效数据');
    };
    await drain({ type: 'begin', exportedAt });
    for (let from = 0; from < entries.length; from += PD_EXPORT_BATCH) {
      await drain({ type: 'entries', entries: entries.slice(from, from + PD_EXPORT_BATCH), first: from === 0 });
    }
    await drain({ type: 'end' });
    if (cancelled) throw new Error('PD 导出已取消');
    await closeWriter(file.handle, { sync: true });
    return entries.length;
  } catch (error) {
    await closeWriter(file.handle, { abort: true }).catch(() => {});
    throw error;
  } finally {
    worker?.terminate();
  }
}

/** Abort and await cleanup before native shutdown. */
export async function cancelPdExport() {
  cancelActive?.();
  await active?.catch(() => {});
}
