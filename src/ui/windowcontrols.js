// @ts-check
/**
 * @file 窗口控制（自定义标题栏配套）。
 *
 * Windows：tauri-plugin-decorum 注入带贴靠布局浮窗的原生按钮
 * （#decorum-tb-minimize/maximize/close），保留其点击与 Win11 贴靠浮窗；
 * 但 decorum 默认用 Segoe Fluent Icons / Segoe MDL2 Assets 私用区字形，
 * 部分 Win10 缺字会显示成方块。本模块把按钮内容换成内置 Fluent SVG
 * （.fi），观感与 styles/app.css 重绘规则对齐。
 *
 * Linux / macOS：decorum 不支持，本模块自绘 最小化 / 最大化还原 / 关闭 三按钮
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

/**
 * 把 decorum 注入的 Segoe 字形换成内置 .fi SVG；保留原按钮节点与事件
 * （含 Win11 最大化贴靠浮窗）。decorum 在 resize 时会改写 maximize 的
 * innerHTML，故用 MutationObserver 再刷回 SVG。
 * @param {{ isMaximized: () => Promise<boolean>, onResized: (cb: () => void) => unknown }} appWindow
 */
function restyleDecorumButtons(appWindow) {
  /** @type {boolean} */
  let painting = false;
  /** @type {boolean} */
  let watching = false;

  /**
   * @param {HTMLElement} btn
   * @param {string} icon
   * @param {string} label
   */
  const setIcon = (btn, icon, label) => {
    const existing = btn.querySelector(':scope > .fi');
    if (existing && existing.classList.contains(`fi-${icon}`) && btn.childNodes.length === 1) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
      return;
    }
    painting = true;
    try {
      const i = document.createElement('i');
      i.className = `fi fi-${icon}`;
      i.setAttribute('aria-hidden', 'true');
      btn.replaceChildren(i);
      btn.title = label;
      btn.setAttribute('aria-label', label);
    } finally {
      queueMicrotask(() => {
        painting = false;
      });
    }
  };

  const syncMaximized = async (maxBtn) => {
    try {
      const maximized = await appWindow.isMaximized();
      setIcon(maxBtn, maximized ? 'restore' : 'maximize', maximized ? '还原' : '最大化');
      document.documentElement.classList.toggle('is-maximized', maximized);
    } catch {
      setIcon(maxBtn, 'maximize', '最大化');
    }
  };

  const paint = () => {
    if (painting) return false;
    const minBtn = document.getElementById('decorum-tb-minimize');
    const maxBtn = document.getElementById('decorum-tb-maximize');
    const closeBtn = document.getElementById('decorum-tb-close');
    if (!minBtn || !maxBtn || !closeBtn) return false;

    setIcon(minBtn, 'subtract', '最小化');
    setIcon(closeBtn, 'dismiss', '关闭');
    // decorum 可能刚写入 \uE923/\uE922；先按字形占位，再以 isMaximized 校准
    const fromGlyph = maxBtn.textContent.includes('\uE923');
    const fromFi = !!maxBtn.querySelector('.fi-restore');
    if (!maxBtn.querySelector('.fi') || fromGlyph) {
      setIcon(maxBtn, fromGlyph || fromFi ? 'restore' : 'maximize', fromGlyph || fromFi ? '还原' : '最大化');
    }
    void syncMaximized(maxBtn);
    return true;
  };

  const watch = () => {
    if (watching) return;
    watching = true;
    const tb = document.querySelector('[data-tauri-decorum-tb]');
    if (tb) {
      new MutationObserver(() => {
        if (!painting) paint();
      }).observe(tb, { childList: true, subtree: true, characterData: true });
    }
    void appWindow.onResized(() => {
      if (!painting) paint();
    });
  };

  if (paint()) {
    watch();
    return;
  }

  const boot = new MutationObserver(() => {
    if (paint()) {
      boot.disconnect();
      watch();
    }
  });
  boot.observe(document.body, { childList: true, subtree: true });
}

/** 初始化标题栏拖拽与窗口控制。窗口按钮在非 Windows 上自绘。 */
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

  if (document.documentElement.getAttribute('data-os') === 'windows') {
    restyleDecorumButtons(appWindow);
    return;
  }

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
    btn.innerHTML = `<i class="fi fi-${icon}" aria-hidden="true"></i>`;
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
    return btn;
  };

  mkBtn('subtract', '最小化', () => void appWindow.minimize().catch(() => {}));
  const maxBtn = mkBtn('maximize', '最大化', () => void appWindow.toggleMaximize().catch(() => {}));
  const closeBtn = mkBtn('dismiss', '关闭', () => void appWindow.close().catch(() => {}));
  closeBtn.classList.add('wc-btn-close');

  const syncMaximized = async () => {
    try {
      const maximized = await appWindow.isMaximized();
      const icon = maxBtn.querySelector('.fi');
      if (icon) icon.className = `fi ${maximized ? 'fi-restore' : 'fi-maximize'}`;
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
      void appWindow.startResizeDragging(direction).catch(() => {});
    });
    document.body.appendChild(zone);
  }
}
