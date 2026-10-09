/**
 * 首屏引导：在样式表之前同步写入 <html data-theme> 与 <html data-os>。
 * data-theme 避免 LazyStore 异步读完之前闪错主题（键名须与 src/theme.js 的 THEME_STORAGE_KEY 一致）。
 * data-os 让 tokens.css 在首帧就选对平台原生字体。
 */
(() => {
  let pref = 'system';
  try {
    const stored = localStorage.getItem('lapower-theme');
    if (stored === 'light' || stored === 'system' || stored === 'dark') pref = stored;
  } catch {
    /* 隐私模式等读失败时跟随系统 */
  }
  let systemDark = true;
  try {
    systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    /* matchMedia 不可用时按深色解析 */
  }
  const resolved = pref === 'light' || (pref === 'system' && !systemDark) ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', resolved);

  const ua = navigator.userAgent;
  document.documentElement.setAttribute(
    'data-os',
    ua.includes('Windows') ? 'windows' : ua.includes('Mac OS') ? 'macos' : 'linux',
  );

  // 与 window-style.js 的 resolveWindowStyle 及镜像键保持一致；异步 LazyStore 最终覆盖。
  // macOS 使用系统原生红绿灯，忽略偏好。
  let windowStyle = 'auto';
  try {
    const stored = localStorage.getItem('lapower-window-style');
    if (stored === 'windows' || stored === 'macos') windowStyle = stored;
  } catch {
    /* 镜像不可用时跟随真实平台。 */
  }
  document.documentElement.setAttribute(
    'data-window-style',
    document.documentElement.getAttribute('data-os') === 'macos'
      ? 'macos'
      : windowStyle === 'auto'
        ? 'windows'
        : windowStyle,
  );
})();
