// @ts-check
/**
 * @file 设置视图 — App 级杂项（配置重置在 app.js 绑定 / 关于信息）。
 * 首次打开时由 shell 的 init 钩子调用。
 */

/** 填充"关于"卡片的版本号等运行时信息。 */
export function initSettingsView() {
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
