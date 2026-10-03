// @ts-check
/**
 * @file 顶栏 Tab 条（Fluent TabView 习惯用法，参考 Windows Terminal）。
 *
 * 只负责渲染与键盘导航（WAI-ARIA tabs 模式：方向键 / Home / End 漫游焦点），
 * 视图切换逻辑在 src/shell.js。工作区入口始终可见，设备能力由各视图启停操作。
 */

/** @typedef {{ id: string, icon: string, label: string, hidden?: boolean }} TabSpec */

/**
 * 在 container 内渲染 Tab 条。
 * @param {HTMLElement} container
 * @param {TabSpec[]} tabs
 * @param {(id: string) => void} onSelect
 * @returns {{ select: (id: string) => void, setHidden: (id: string, hidden: boolean) => void }}
 */
export function initTabBar(container, tabs, onSelect) {
  container.setAttribute('role', 'tablist');
  container.setAttribute('aria-label', '工作区');

  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();
  let selectedId = '';

  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.id = `tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-controls', `view-${tab.id}`);
    btn.tabIndex = -1;
    btn.hidden = tab.hidden === true;
    btn.innerHTML = `<i class="fi fi-${tab.icon}" aria-hidden="true"></i><span>${tab.label}</span>`;
    btn.addEventListener('click', () => onSelect(tab.id));
    container.appendChild(btn);
    buttons.set(tab.id, btn);
  }

  /** 可见 Tab，按显示顺序。 */
  const visibleButtons = () => Array.from(buttons.values()).filter((btn) => !btn.hidden);

  container.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const list = visibleButtons();
    const current = document.activeElement instanceof HTMLButtonElement ? list.indexOf(document.activeElement) : -1;
    if (current === -1) return;
    e.preventDefault();
    let next = current;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowRight') next = (current + 1) % list.length;
    else next = (current - 1 + list.length) % list.length;
    list[next].focus();
    // 焦点即选中（tabs 模式的自动激活变体）
    const id = list[next].id.replace(/^tab-/, '');
    onSelect(id);
  });

  /** 保证恰好一个可见 Tab 可以 Tab 键落点。 */
  function syncTabStops() {
    let focusable = null;
    for (const [tabId, btn] of buttons) {
      const selected = tabId === selectedId && !btn.hidden;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
      if (selected) focusable = btn;
    }
    // 激活了 tablist 之外的视图（如设置）时，保留第一个可见 Tab 作为键盘落点
    if (!focusable) {
      const first = visibleButtons()[0];
      if (first) first.tabIndex = 0;
    }
  }

  /** @param {string} id */
  function select(id) {
    selectedId = id;
    syncTabStops();
  }

  /** @param {string} id @param {boolean} hidden */
  function setHidden(id, hidden) {
    const btn = buttons.get(id);
    if (!btn || btn.hidden === hidden) return;
    btn.hidden = hidden;
    syncTabStops();
  }

  return { select, setHidden };
}
