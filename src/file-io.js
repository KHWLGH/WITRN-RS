// @ts-check
/**
 * @file 后端文件句柄的前端封装：CSV 导出 / 导入 / 临时恢复文件。
 *
 * 路径只由后端的原生对话框或应用缓存决定，前端拿到的是句柄与显示用的路径；
 * 数据以原始字节分块传输，不经 JSON，也不在 WebView 里拼出整份文件。
 */

/** @typedef {{ handle: number, name: string, path: string, size: number }} OpenedFile */

import { t } from './i18n.js';

const encoder = new TextEncoder();

/** @param {string} command @param {unknown} [args] @param {{ headers: Record<string, string> }} [options] */
function invoke(command, args, options) {
  return /** @type {any} */ (window.__TAURI__.core).invoke(command, args, options);
}

/**
 * 弹出保存对话框并创建导出文件；取消时为 null。
 * @param {string} defaultName
 * @returns {Promise<OpenedFile|null>}
 */
export function pickExportFile(defaultName) {
  return invoke('csv_export_pick', { defaultName, title: t('exportCsv'), filterName: t('csvFile') });
}

/** @param {string} defaultName @returns {Promise<OpenedFile|null>} */
export function pickPdExportFile(defaultName) {
  return invoke('pd_export_pick', { defaultName, title: t('pdExportTitle'), filterName: t('pdFile') });
}

/** @returns {Promise<OpenedFile|null>} 选择要导入的 CSV；取消时为 null。 */
export function pickImportFile() {
  return invoke('csv_import_pick', { title: t('importCsv'), filterName: t('csvFile') });
}

/**
 * 读取下一块（最多 4 MiB），读完时返回空块。
 * @param {number} handle
 * @returns {Promise<ArrayBuffer>}
 */
export async function readChunk(handle) {
  const bytes = await invoke('csv_read_chunk', { handle });
  if (bytes instanceof ArrayBuffer) return bytes;
  // 旧版 IPC 以数字数组返回原始字节。
  if (Array.isArray(bytes)) return new Uint8Array(bytes).buffer;
  throw new Error('fileInvalidBytes');
}

/** @param {number} handle */
export function closeReader(handle) {
  return invoke('csv_read_close', { handle });
}

/**
 * 追加文本（按 UTF-8 编码）。
 * @param {number} handle
 * @param {string} text
 */
export function writeText(handle, text) {
  return writeBytes(handle, encoder.encode(text));
}

/** @param {number} handle @param {Uint8Array} bytes */
export function writeBytes(handle, bytes) {
  return invoke('csv_write_chunk', bytes, { headers: { 'x-handle': String(handle) } });
}

/**
 * 在表头可回写区域内原地覆盖，长度必须与原内容相同。
 * @param {number} handle
 * @param {number} offset
 * @param {string} text
 */
export function patchText(handle, offset, text) {
  return invoke('csv_write_patch', encoder.encode(text), {
    headers: { 'x-handle': String(handle), 'x-offset': String(offset) },
  });
}

/** @param {number} handle */
export function syncFile(handle) {
  return invoke('csv_write_sync', { handle });
}

/**
 * @param {number} handle
 * @param {{ sync?: boolean, abort?: boolean, removeOnSuccess?: boolean }} [options]
 * abort 丢弃失败导出；removeOnSuccess 仅成功同步后删除恢复文件，二者互斥。
 */
export function closeWriter(handle, options = {}) {
  return invoke('csv_write_close', { handle, options });
}

/**
 * 在应用缓存中创建本次记录的临时文件。
 * @param {string} stem 文件名主干，后端会规整为可移植字符
 * @param {number} headerLen 随后写入、之后允许原地回写的表头字节数
 * @returns {Promise<OpenedFile>}
 */
export function openSpool(stem, headerLen) {
  return invoke('spool_open', { stem, headerLen });
}

/** @typedef {{id:string, name:string, size:number, modified_ms:number}} RecoveryEntry */

/** @returns {Promise<RecoveryEntry[]>} 未正常收尾的临时记录 */
export function listSpoolRecoveries() {
  return invoke('spool_recovery_list');
}

/** @param {string} id @returns {Promise<OpenedFile>} 打开一份临时记录供流式导入 */
export function openSpoolRecovery(id) {
  return invoke('spool_recovery_open', { id });
}

/** @param {string} id */
export function deleteSpoolRecovery(id) {
  return invoke('spool_recovery_delete', { id });
}
