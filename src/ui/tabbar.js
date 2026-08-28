// @ts-check
/**
 * @file 顶栏 Tab 条（Fluent TabView 习惯用法，参考 Windows Terminal）。
 *
 * 只负责渲染与键盘导航（WAI-ARIA tabs 模式：方向键 / Home / End 漫游焦点），
 * 视图切换逻辑在 src/shell.js。
 */

/** @typedef {{ id: string, icon: string, label: string }} TabSpec */

/**
 * 在 container 内渲染 Tab 条。
 * @param {HTMLElement} container
 * @param {TabSpec[]} tabs
 * @param {(id: string) => void} onSelect
 * @returns {{ select: (id: string) => void }}
 */
export function initTabBar(container, tabs, onSelect) {
  container.setAttribute('role', 'tablist');
  container.setAttribute('aria-label', '工作区');

  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();

  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.id = `tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-controls', `view-${tab.id}`);
    btn.tabIndex = -1;
    btn.innerHTML = `<i class="fi fi-${tab.icon}" aria-hidden="true"></i><span>${tab.label}</span>`;
    btn.addEventListener('click', () => onSelect(tab.id));
    container.appendChild(btn);
    buttons.set(tab.id, btn);
  }

  container.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const list = Array.from(buttons.values());
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

  /** @param {string} id */
  function select(id) {
    for (const [tabId, btn] of buttons) {
      const selected = tabId === id;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    }
    // 激活了 tablist 之外的视图（如设置）时，保留第一个 Tab 作为键盘落点
    if (!buttons.has(id)) {
      const first = buttons.values().next().value;
      if (first) first.tabIndex = 0;
    }
  }

  return { select };
}
