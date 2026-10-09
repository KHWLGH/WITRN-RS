// @ts-check
/**
 * @file 菜单原语（Fluent 风格）— 统一取代各处手写的下拉菜单逻辑。
 *
 * 菜单元素在创建时即挂到 document.body（隐藏），因此菜单项的 DOM id
 * 始终可被 getElementById 找到（temperature.js 依赖这一点切换导出项的可见性）。
 * position: fixed 定位，空间不足时向上翻转；外部点击 / Escape / 窗口
 * resize / 滚动时关闭（与 dropdown.js 的策略一致）。
 */

/** @typedef {{ id: string, label: string, icon?: string, danger?: boolean, onSelect: () => void }} MenuItem */

/**
 * 创建一个由 trigger 按钮触发的菜单。
 * @param {HTMLElement} trigger
 * @param {MenuItem[]} items
 * @returns {{ open: () => void, close: () => void, toggle: () => void, setHidden: (id: string, hidden: boolean) => void, setDisabled: (id: string, disabled: boolean) => void, setLabel: (id: string, label: string) => void, el: HTMLElement }}
 */
export function createMenu(trigger, items) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = trigger.id ? `menu-${trigger.id}` : `menu-${Math.floor(performance.now())}`;
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = item.id;
    btn.className = 'menu-item';
    if (item.danger) btn.classList.add('menu-item-danger');
    btn.setAttribute('role', 'menuitem');
    if (item.icon) {
      const icon = document.createElement('i');
      const name = item.icon.replace(/^fi-/, '');
      icon.className = `fi fi-${name}`;
      icon.setAttribute('aria-hidden', 'true');
      btn.appendChild(icon);
    }
    btn.appendChild(document.createTextNode(item.label));
    btn.addEventListener('click', () => {
      close();
      item.onSelect();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-expanded', 'false');

  /** 当前可交互的菜单项（可见且未禁用）。 */
  const activeItems = () =>
    /** @type {HTMLButtonElement[]} */ (
      Array.from(menu.querySelectorAll('[role="menuitem"]:not(.hidden):not(:disabled)'))
    );

  function position() {
    const rect = trigger.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(120, rect.width)}px`;
    // 先离屏测量再定位
    menu.style.visibility = 'hidden';
    menu.hidden = false;
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight && rect.top - mh - 4 >= 0) top = rect.top - mh - 4;
    let left = rect.left;
    if (left + mw > window.innerWidth) left = Math.max(0, window.innerWidth - mw - 4);
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.visibility = '';
  }

  /** @param {PointerEvent} e */
  const onOutsidePointerDown = (e) => {
    const target = /** @type {Node} */ (e.target);
    if (!menu.contains(target) && !trigger.contains(target)) close();
  };
  /** @param {KeyboardEvent} e */
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      trigger.focus();
      return;
    }
    if (e.key === 'Tab') {
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = activeItems();
    if (list.length === 0) return;
    e.preventDefault();
    const current = document.activeElement instanceof HTMLButtonElement ? list.indexOf(document.activeElement) : -1;
    let next = current;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowDown') next = (current + 1 + list.length) % list.length;
    else next = (current - 1 + list.length) % list.length;
    list[next].focus();
  };
  const onDismiss = () => close();

  function open() {
    if (!menu.hidden) return;
    position();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    activeItems()[0]?.focus();
  }

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('scroll', onDismiss, true);
  }

  function toggle() {
    if (menu.hidden) open();
    else close();
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  /** @param {string} id @param {boolean} hidden */
  function setHidden(id, hidden) {
    const el = menu.querySelector(`#${CSS.escape(id)}`);
    el?.classList.toggle('hidden', hidden);
  }

  /** @param {string} id @param {boolean} disabled */
  function setDisabled(id, disabled) {
    const el = /** @type {HTMLButtonElement|null} */ (menu.querySelector(`#${CSS.escape(id)}`));
    if (el) el.disabled = disabled;
  }

  /** @param {string} id @param {string} label */
  function setLabel(id, label) {
    const item = menu.querySelector(`#${CSS.escape(id)}`);
    if (!item) return;
    const text = Array.from(item.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (text) text.nodeValue = label;
    else item.appendChild(document.createTextNode(label));
  }

  return { open, close, toggle, setHidden, setDisabled, setLabel, el: menu };
}
