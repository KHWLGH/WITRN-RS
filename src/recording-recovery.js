// @ts-check
/** Shared crash-recovery list and actions for notifications and the settings page. */
import { deleteSpoolRecovery, listSpoolRecoveries } from './file-io.js';
import { showView } from './shell.js';
import { toast } from './ui/toast.js';

/** @typedef {import('./file-io.js').RecoveryEntry} RecoveryEntry */
/** @type {Map<string, RecoveryEntry>} */
const entries = new Map();
/** @type {Map<string, import('./ui/toast.js').ToastHandle>} */
const notifications = new Map();
/** @type {Set<(entries: RecoveryEntry[]) => void>} */
const subscribers = new Set();
const processing = new Set();
let recovering = false;
/** @type {Promise<void>|null} */
let scan = null;

function notify() {
  for (const handle of notifications.values()) handle.refreshActions();
  const snapshot = [...entries.values()];
  for (const subscriber of subscribers) subscriber(snapshot);
}

/** @param {string} id @param {'recover'|'delete'} action */
export function recoveryActionDisabled(id, action) {
  return !entries.has(id) || processing.has(id) || (action === 'recover' && recovering);
}

/** @param {(entries: RecoveryEntry[]) => void} subscriber */
export function subscribeRecoveries(subscriber) {
  subscribers.add(subscriber);
  subscriber([...entries.values()]);
  return () => subscribers.delete(subscriber);
}

/** @param {string} id @param {'recover'|'delete'} action @returns {Promise<boolean>} */
export async function processRecovery(id, action) {
  if (recoveryActionDisabled(id, action)) return false;
  const entry = /** @type {RecoveryEntry} */ (entries.get(id));
  /** Keep failures visible even when three persistent notifications occupy every toast slot. @param {string} message */
  const reportFailure = (message) => {
    notifications.get(id)?.setText(`${entry.name}\n${message}`);
    toast.error(message);
  };
  processing.add(id);
  if (action === 'recover') recovering = true;
  notify();
  try {
    if (action === 'recover') {
      const { importSpoolRecovery } = await import('./csv.js');
      if (!(await importSpoolRecovery(id, reportFailure))) return false;
      showView('monitor');
    } else {
      await deleteSpoolRecovery(id);
    }
    entries.delete(id);
    notifications.get(id)?.dismiss();
    notifications.delete(id);
    if (action === 'delete') toast.success('临时记录已删除');
    return true;
  } catch (error) {
    reportFailure(`${action === 'recover' ? '恢复' : '删除'}临时记录失败: ${error}`);
    return false;
  } finally {
    processing.delete(id);
    if (action === 'recover') recovering = false;
    notify();
  }
}

/** Scan once per launch; the settings page subscribes to the same result. Failed scans can be retried. */
export function scanRecoveries() {
  if (scan) return scan;
  scan = listSpoolRecoveries()
    .then((found) => {
      for (const entry of found) {
        entries.set(entry.id, entry);
        if (notifications.has(entry.id)) continue;
        const handle = toast.warning(`发现未正常结束的记录：${entry.name}（${(entry.size / 1048576).toFixed(1)} MB）`, {
          duration: 0,
          actions: [
            {
              label: '恢复',
              onClick: () => processRecovery(entry.id, 'recover'),
              disabled: () => recoveryActionDisabled(entry.id, 'recover'),
            },
            {
              label: '删除',
              onClick: () => processRecovery(entry.id, 'delete'),
              disabled: () => recoveryActionDisabled(entry.id, 'delete'),
            },
          ],
        });
        notifications.set(entry.id, handle);
      }
      notify();
    })
    .catch((error) => {
      scan = null;
      toast.error(`扫描临时恢复文件失败: ${error}`);
      throw error;
    });
  return scan;
}
