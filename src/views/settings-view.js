// @ts-check
/**
 * @file 设置视图 — App 级杂项（配置重置在 app.js 绑定 / 关于信息 / 临时恢复文件）。
 * 首次打开时由 shell 的 init 钩子调用。
 */

import { deleteSpoolRecovery, listSpoolRecoveries } from '../file-io.js';
import { toast } from '../ui/toast.js';

/** @typedef {{id:string, name:string, size:number, modified_ms:number}} RecoveryEntry */

/** @param {RecoveryEntry[]} entries */
export function showSpoolRecoveries(entries) {
  const el = document.getElementById('spool-recovery-status');
  if (!el) return;
  if (!entries.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = `发现 ${entries.length} 份未正常结束的临时记录，可在此恢复或删除。`;
  el.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'recovery-entry';
    const label = document.createElement('span');
    label.textContent = `${entry.name}（${(entry.size / 1048576).toFixed(1)} MB）`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = '删除';
    const recover = document.createElement('button');
    recover.type = 'button';
    recover.className = 'btn';
    recover.textContent = '恢复';
    recover.addEventListener('click', async () => {
      try {
        const module = await import('../csv.js');
        await module.importSpoolRecovery(entry.id);
        row.remove();
      } catch (error) {
        toast.error(`恢复临时记录失败: ${error}`);
      }
    });
    remove.addEventListener('click', async () => {
      try {
        await deleteSpoolRecovery(entry.id);
        row.remove();
        toast.success('临时记录已删除');
      } catch (error) {
        toast.error(`删除临时记录失败: ${error}`);
      }
    });
    row.append(label, recover, remove);
    el.append(row);
  }
}

/** 填充"关于"卡片的版本号等运行时信息。 */
export function initSettingsView() {
  // 点分段项时不要把焦点留在隐藏 radio 上，否则浅色主题会画出黑框。
  // 键盘 Tab 仍可聚焦；mousedown preventDefault 只取消“点击即聚焦”。
  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('mousedown', (event) => {
      if (event.target instanceof Element && event.target.closest('.seg-item')) {
        event.preventDefault();
      }
    });
  }

  listSpoolRecoveries()
    .then(showSpoolRecoveries)
    .catch((/** @type {unknown} */ error) => console.error('读取临时恢复文件失败:', error));

  const versionEl = document.getElementById('about-version');
  if (!versionEl) return;
  const appApi = /** @type {any} */ (window.__TAURI__).app;
  if (appApi?.getVersion) {
    appApi
      .getVersion()
      .then((/** @type {string} */ v) => {
        versionEl.textContent = `v${v}`;
      })
      .catch(() => {
        versionEl.textContent = '--';
      });
  }
}
