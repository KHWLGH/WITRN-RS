// @ts-check
/**
 * @file 浮出面板（Fluent Flyout）— 命令栏"显示 / 自动暂停 / 温度服务"等设置面板的容器。
 *
 * 面板内容是 index.html 里的静态 HTML（保持 ID 契约，settings.js 等模块的
 * getElementById 回显逻辑零改动），本模块只负责显隐、定位与轻退出
 * （外部点击 / Escape / resize / 滚动关闭，与 dropdown.js 策略一致）。
 * 同一时刻只开一个 flyout。
 */

/** @type {(() => void)|null} 当前打开面板的关闭函数 */
let closeCurrent = null;

/**
 * 把 panel 变成由 anchor 触发的浮出面板。
 * @param {HTMLElement} anchor
 * @param {HTMLElement} panel
 * @returns {{ open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean }}
 */
export function createFlyout(anchor, panel) {
  panel.classList.add('flyout-panel');
  panel.setAttribute('role', 'dialog');
  if (!panel.getAttribute('aria-label') && anchor.textContent) {
    panel.setAttribute('aria-label', anchor.textContent.trim());
  }
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'false');

  function position() {
    const rect = anchor.getBoundingClientRect();
    panel.style.visibility = 'hidden';
    panel.hidden = false;
    const ph = panel.offsetHeight;
    const pw = panel.offsetWidth;
    let top = rect.bottom + 4;
    if (top + ph > window.innerHeight && rect.top - ph - 4 >= 0) top = rect.top - ph - 4;
    let left = rect.left;
    if (left + pw > window.innerWidth) left = Math.max(0, window.innerWidth - pw - 4);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.visibility = '';
  }

  /** @param {PointerEvent} e */
  const onOutsidePointerDown = (e) => {
    const target = /** @type {Node} */ (e.target);
    // 面板里的自定义下拉（dropdown.js）会把菜单挂到 body，点它不算"外部"
    const inDropdownMenu = target instanceof Element && target.closest('.cs-menu') !== null;
    if (!panel.contains(target) && !anchor.contains(target) && !inDropdownMenu) close();
  };
  /** @param {KeyboardEvent} e */
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  const onDismiss = () => close();

  function open() {
    if (!panel.hidden) return;
    closeCurrent?.();
    position();
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onDismiss);
    closeCurrent = close;
    const first = /** @type {HTMLElement|null} */ (
      panel.querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled])')
    );
    first?.focus();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onDismiss);
    if (closeCurrent === close) closeCurrent = null;
  }

  function toggle() {
    if (panel.hidden) open();
    else close();
  }

  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  return { open, close, toggle, isOpen: () => !panel.hidden };
}
