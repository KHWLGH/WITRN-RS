// @ts-check
/**
 * @file 窗口控制（自定义标题栏配套）。
 *
 * Windows：tauri-plugin-decorum 注入带贴靠布局浮窗的原生按钮
 * （#decorum-tb-minimize/maximize/close），本模块不再画按钮，只做样式
 * 层面的重绘（styles/app.css）。
 *
 * Linux：decorum 不支持，本模块自绘 最小化 / 最大化还原 / 关闭 三按钮
 * （与 Windows 侧共享同一套 CSS 观感），并在四边+四角放透明热区调
 * startResizeDragging() 实现无边框窗口的边缘调整大小（Linux 无 shadow
 * 装饰，窗口管理器不提供拉伸边）。
 *
 * 关闭按钮走 appWindow.close() → 触发既有 onCloseRequested 退出确认流程。
 */

/** 边缘热区方向 → CSS 光标。 */
const RESIZE_DIRECTIONS = /** @type {const} */ ({
  North: 'n-resize',
  South: 's-resize',
  East: 'e-resize',
  West: 'w-resize',
  NorthEast: 'ne-resize',
  NorthWest: 'nw-resize',
  SouthEast: 'se-resize',
  SouthWest: 'sw-resize',
});

/** 初始化标题栏拖拽与窗口控制。窗口按钮仅 Linux 需要自绘。 */
export function initWindowControls() {
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  // decorum/无边框窗口下，显式调用 startDragging 比依赖 HTML 属性更稳定。
  // 交互控件不参与拖拽，避免点击按钮或下拉框时同时移动窗口。
  const titlebar = document.getElementById('titlebar');
  if (titlebar) {
    titlebar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('button, select, input, textarea, a, .titlebar-connect, .titlebar-tabs, .titlebar-controls'))
        return;
      event.preventDefault();
      void appWindow.startDragging().catch(() => {
        /* 窗口销毁或平台不支持时忽略 */
      });
    });
  }

  if (document.documentElement.getAttribute('data-os') !== 'linux') return;

  const container = document.getElementById('titlebar-controls');
  if (!container) return;

  /**
   * @param {string} icon @param {string} label @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  const mkBtn = (icon, label, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wc-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<i class="codicon ${icon}" aria-hidden="true"></i>`;
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
    return btn;
  };

  mkBtn('codicon-chrome-minimize', '最小化', () => appWindow.minimize());
  const maxBtn = mkBtn('codicon-chrome-maximize', '最大化', () => appWindow.toggleMaximize());
  const closeBtn = mkBtn('codicon-chrome-close', '关闭', () => appWindow.close());
  closeBtn.classList.add('wc-btn-close');

  const syncMaximized = async () => {
    try {
      const maximized = await appWindow.isMaximized();
      const icon = maxBtn.querySelector('.codicon');
      if (icon) icon.className = `codicon ${maximized ? 'codicon-chrome-restore' : 'codicon-chrome-maximize'}`;
      maxBtn.title = maximized ? '还原' : '最大化';
      maxBtn.setAttribute('aria-label', maxBtn.title);
      document.documentElement.classList.toggle('is-maximized', maximized);
    } catch {
      /* 窗口销毁竞态，忽略 */
    }
  };
  appWindow.onResized(() => void syncMaximized());
  void syncMaximized();

  // 边缘调整大小热区（最大化时由 CSS .is-maximized 隐藏）
  for (const direction of Object.keys(RESIZE_DIRECTIONS)) {
    const zone = document.createElement('div');
    zone.className = `resize-zone resize-${direction.toLowerCase()}`;
    zone.style.cursor = RESIZE_DIRECTIONS[/** @type {keyof typeof RESIZE_DIRECTIONS} */ (direction)];
    zone.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void appWindow.startResizeDragging(direction);
    });
    document.body.appendChild(zone);
  }
}
