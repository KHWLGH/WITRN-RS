// @ts-check
/**
 * 窗口动作始终按真实 data-os 分发，data-window-style 只负责 CSS 皮肤。
 * Windows 保留 decorum 原节点、ID、class、click/hover 监听和 Snap（macOS 皮肤下由 guardDecorumSnap 常驻拦下）；
 * Mac/Linux 单次创建自绘按钮。Mac 不注册 decorum，也不创建 Tao 未实现的缩放热区。
 * close() 继续进入现有 onCloseRequested 确认流程。
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

let initialized = false;

/** @param {HTMLElement} btn @param {string} icon @param {string} label */
function setIcon(btn, icon, label) {
  const existing = btn.querySelector(':scope > .fi');
  if (!existing?.classList.contains(`fi-${icon}`) || btn.childNodes.length !== 1) {
    const i = document.createElement('i');
    i.className = `fi fi-${icon}`;
    i.setAttribute('aria-hidden', 'true');
    btn.replaceChildren(i);
  }
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/** 保留按钮本身，仅替换缺字的 Segoe 图标；插件 resize 写字形后重新绘制。 */
function restyleDecorumButtons() {
  const paint = () => {
    const minBtn = document.getElementById('decorum-tb-minimize');
    const maxBtn = document.getElementById('decorum-tb-maximize');
    const closeBtn = document.getElementById('decorum-tb-close');
    if (!minBtn || !maxBtn || !closeBtn) return false;
    setIcon(minBtn, 'subtract', '最小化');
    setIcon(closeBtn, 'dismiss', '关闭');
    const maximized = document.documentElement.classList.contains('is-maximized');
    setIcon(maxBtn, maximized ? 'restore' : 'maximize', maximized ? '还原' : '最大化');
    attachSnapGuard(maxBtn);
    return true;
  };
  const watch = () => {
    const tb = document.querySelector('[data-tauri-decorum-tb]');
    if (tb) new MutationObserver(paint).observe(tb, { childList: true, subtree: true, characterData: true });
  };
  if (paint()) {
    watch();
  } else {
    const boot = new MutationObserver(() => {
      if (!paint()) return;
      boot.disconnect();
      watch();
    });
    boot.observe(document.body, { childList: true, subtree: true });
  }
  return paint;
}

/**
 * decorum 1.1.1 的贴取布局：#decorum-tb-maximize 上 mouseenter 武装 620ms timer，到点才 setFocus + invoke，
 * mouseleave 里 clearTimeout。插件用 `const invoke = tauri.core.invoke` 一次性捕获，而
 * __TAURI_INTERNALS__.invoke 是只读属性，IPC 边界拦不了（赋值抛 TypeError，曾连带把整个初始化打断）。
 * 只能挂在同一个节点上：Blink 把 mouseenter/mouseleave 只派发给目标元素，祖先的捕获监听器收不到，
 * 所以委托到 document 不成立。同节点上注册顺序即调用顺序，我们晚于插件，此时 timer 已写入，同步补发即可。
 */
function attachSnapGuard(btn) {
  if (btn.getAttribute('data-snap-guarded')) return;
  btn.setAttribute('data-snap-guarded', '1');
  btn.addEventListener('mouseenter', () => {
    if (document.documentElement.getAttribute('data-window-style') !== 'macos') return;
    btn.dispatchEvent(new MouseEvent('mouseleave'));
  });
}

/** 切到 macOS 皮肤时，取消切换前已武装的那次 timer。 */
function guardDecorumSnap() {
  const root = document.documentElement;
  new MutationObserver(() => {
    if (root.getAttribute('data-window-style') !== 'macos') return;
    document.getElementById('decorum-tb-maximize')?.dispatchEvent(new MouseEvent('mouseleave'));
  }).observe(root, { attributes: true, attributeFilter: ['data-window-style'] });
}

/** 初始化一次；后续风格切换只更新 CSS，不新增按钮、监听器或热区。 */
export function initWindowControls() {
  if (initialized) return;
  const titlebar = document.getElementById('titlebar');
  const container = document.getElementById('titlebar-controls');
  if (!titlebar || !container) return;
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const root = document.documentElement;
  const os = root.getAttribute('data-os');
  const isMac = os === 'macos';
  initialized = true;

  titlebar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      target.closest(
        'button, select, input, textarea, a, [role="button"], [contenteditable], .titlebar-connect, .titlebar-tabs, .titlebar-controls, [data-tauri-decorum-tb]',
      )
    )
      return;
    event.preventDefault();
    void appWindow.startDragging().catch(() => {});
  });

  /** @type {HTMLElement|null} */
  let maxBtn = null;
  /** @type {() => void} */
  let paint = () => {};
  let syncing = false;
  let syncAgain = false;
  const syncWindowState = async () => {
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        const [maximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
        root.classList.toggle('is-maximized', maximized);
        root.classList.toggle('is-fullscreen', fullscreen);
        if (maxBtn) {
          const expanded = isMac ? fullscreen : maximized;
          setIcon(
            maxBtn,
            expanded ? 'restore' : 'maximize',
            isMac ? (fullscreen ? '退出全屏' : '进入全屏') : maximized ? '还原' : '最大化',
          );
        }
        paint();
      } while (syncAgain);
    } catch {
      /* 窗口销毁期间不再刷新。 */
    } finally {
      syncing = false;
    }
  };

  if (os === 'windows') {
    guardDecorumSnap();
    paint = restyleDecorumButtons();
  } else {
    /** @param {string} action @param {string} icon @param {string} label @param {() => Promise<unknown>} onClick */
    const mkBtn = (action, icon, label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `wc-btn wc-btn-${action}`;
      setIcon(btn, icon, label);
      btn.addEventListener('click', () => {
        void onClick().catch(() => {});
      });
      container.appendChild(btn);
      return btn;
    };
    mkBtn('minimize', 'subtract', '最小化', () => appWindow.minimize());
    maxBtn = mkBtn('maximize', 'maximize', isMac ? '进入全屏' : '最大化', async () => {
      if (isMac) await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
      else await appWindow.toggleMaximize();
      await syncWindowState();
    });
    mkBtn('close', 'dismiss', '关闭', () => appWindow.close());
  }

  // 全屏切换也会触发 resize；合并并发状态读取，避免较旧结果覆盖最新状态。
  void appWindow.onResized(() => void syncWindowState());
  void syncWindowState();

  // Windows 沿用原生边缘缩放；Mac 不添加会阻挡原生边缘命中的无效热区。
  if (os !== 'linux') return;
  for (const direction of Object.keys(RESIZE_DIRECTIONS)) {
    const zone = document.createElement('div');
    zone.className = `resize-zone resize-${direction.toLowerCase()}`;
    zone.style.cursor = RESIZE_DIRECTIONS[/** @type {keyof typeof RESIZE_DIRECTIONS} */ (direction)];
    zone.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || root.classList.contains('is-maximized') || root.classList.contains('is-fullscreen'))
        return;
      event.preventDefault();
      void appWindow.startResizeDragging(direction).catch(() => {});
    });
    document.body.appendChild(zone);
  }
}
