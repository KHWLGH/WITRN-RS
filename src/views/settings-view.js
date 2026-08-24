// @ts-check
/**
 * @file 设置视图 — App 级杂项（配置重置在 app.js 绑定 / 关于信息）。
 * 首次打开时由 shell 的 init 钩子调用。
 */

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
