// @ts-check
/**
 * @file 自定义下拉组件 — 替换原生 <select> 的弹出列表。
 *
 * Linux/WebKitGTK 下 <select> 展开后的选项列表由 GTK 原生控件绘制，CSS 完全
 * 作用不到，深色主题里永远是白底。这里保留原生 <select> 作为唯一数据源
 * （既有代码继续用 .value / .options / .selectedIndex / 'change'，无需改动），
 * 只把它在视觉上隐藏，另外渲染一套纯 DOM 的按钮 + 列表。
 *
 * 三个同步方向：
 * - DOM 变更（增删 option、disabled）→ MutationObserver → 重绘
 * - 代码赋值（.value / .selectedIndex）→ 实例上的属性拦截 → 重绘
 * - 用户点选 → 写回原生 select → 派发 bubbles 的 'change'
 */

const selectProto = HTMLSelectElement.prototype;
const nativeValue = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(selectProto, 'value'));
const nativeIndex = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(selectProto, 'selectedIndex'));

/** 已增强过的 select，避免重复包装。 @type {WeakSet<HTMLSelectElement>} */
const enhanced = new WeakSet();

/** 同一时刻只允许一个菜单展开。 @type {Dropdown|null} */
let openDropdown = null;

let globalsInstalled = false;
let uid = 0;

/** 读取原生 selectedIndex，绕过实例上的拦截器。 @param {HTMLSelectElement} el @returns {number} */
function readIndex(el) {
  return Number(nativeIndex.get?.call(el) ?? -1);
}

/** 写入原生 selectedIndex，绕过实例上的拦截器（避免重复 sync）。 @param {HTMLSelectElement} el @param {number} i */
function writeIndex(el, i) {
  nativeIndex.set?.call(el, i);
}

class Dropdown {
  /** @param {HTMLSelectElement} select */
  constructor(select) {
    uid += 1;
    this.id = `cs-${uid}`;
    this.select = select;
    /** 菜单是否展开。 */
    this.isOpen = false;
    /** 键盘/悬停高亮项下标（与选中项相互独立）。 */
    this.activeIndex = -1;
    /** 首字母跳转缓冲。 */
    this.typeBuffer = '';
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.typeTimer = undefined;

    // 包装层继承 select 的行内尺寸样式，保证在父级 flex/grid 里占位不变。
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'cs';
    this.wrapper.style.cssText = select.style.cssText;

    this.button = document.createElement('button');
    this.button.type = 'button';
    // 沿用 select 原有的外观类（.ribbon-select 等），关闭态视觉完全一致。
    this.button.className = `cs-button ${select.className}`.trim();
    this.button.style.cssText = select.style.cssText;
    this.button.id = `${this.id}-button`;
    this.button.setAttribute('role', 'combobox');
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    if (select.title) this.button.title = select.title;

    this.label = document.createElement('span');
    this.label.className = 'cs-label';
    const arrow = document.createElement('span');
    arrow.className = 'cs-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    this.button.append(this.label, arrow);

    // 菜单挂到 body 并用 position:fixed，避开 ribbon 的 overflow 裁剪和层叠上下文。
    this.menu = document.createElement('div');
    this.menu.className = 'cs-menu';
    this.menu.id = `${this.id}-menu`;
    this.menu.setAttribute('role', 'listbox');

    select.parentNode?.insertBefore(this.wrapper, select);
    this.wrapper.append(select, this.button);
    select.classList.add('cs-native');
    select.style.cssText = '';
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    this.button.addEventListener('click', () => this.toggle());
    this.button.addEventListener('keydown', (e) => this.onKeydown(e));
    this.menu.addEventListener('click', (e) => this.onMenuClick(e));
    this.menu.addEventListener('pointermove', (e) => this.onMenuHover(e));

    // option 的增删改、以及 select/option 上的 disabled 变化都要反映到按钮和菜单。
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(select, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'selected', 'value'],
    });

    // .value / .selectedIndex 是属性赋值，不反映到 attribute，MutationObserver 看不到，
    // 只能在实例上拦截（原型上的行为保持不变）。
    const self = this;
    Object.defineProperty(select, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        return nativeValue.get?.call(this);
      },
      set(v) {
        nativeValue.set?.call(this, v);
        self.sync();
      },
    });
    Object.defineProperty(select, 'selectedIndex', {
      configurable: true,
      enumerable: true,
      get() {
        return nativeIndex.get?.call(this);
      },
      set(v) {
        nativeIndex.set?.call(this, v);
        self.sync();
      },
    });

    this.sync();
  }

  /** 把原生 select 的当前状态刷到按钮和菜单上。 */
  sync() {
    const opt = this.select.options[readIndex(this.select)];
    this.label.textContent = opt ? opt.textContent : '';
    this.button.disabled = this.select.disabled;
    if (this.select.disabled && this.isOpen) this.close();
    if (this.isOpen) this.renderMenu();
  }

  /** 按当前 options 重建菜单项。 */
  renderMenu() {
    const selected = readIndex(this.select);
    this.menu.textContent = '';
    for (const [i, opt] of Array.from(this.select.options).entries()) {
      const item = document.createElement('div');
      item.className = 'cs-option';
      item.id = `${this.id}-opt-${i}`;
      item.setAttribute('role', 'option');
      item.dataset.index = String(i);
      item.textContent = opt.textContent;
      if (opt.disabled) item.setAttribute('aria-disabled', 'true');
      if (i === selected) {
        item.classList.add('is-selected');
        item.setAttribute('aria-selected', 'true');
      } else {
        item.setAttribute('aria-selected', 'false');
      }
      if (i === this.activeIndex) item.classList.add('is-active');
      this.menu.appendChild(item);
    }
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen || this.select.disabled || this.select.options.length === 0) return;
    openDropdown?.close();
    this.isOpen = true;
    this.activeIndex = readIndex(this.select);
    this.renderMenu();
    document.body.appendChild(this.menu);
    this.position();
    this.button.setAttribute('aria-expanded', 'true');
    this.button.setAttribute('aria-controls', this.menu.id);
    this.setActive(this.activeIndex >= 0 ? this.activeIndex : this.nextEnabled(-1, 1));
    openDropdown = this;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.remove();
    this.button.setAttribute('aria-expanded', 'false');
    this.button.removeAttribute('aria-controls');
    this.button.removeAttribute('aria-activedescendant');
    if (openDropdown === this) openDropdown = null;
  }

  /** 把菜单定位到按钮下方；下方空间不够时翻到上方。 */
  position() {
    const r = this.button.getBoundingClientRect();
    const gap = 8;
    this.menu.style.minWidth = `${r.width}px`;
    this.menu.style.maxHeight = '';

    const below = window.innerHeight - r.bottom - gap;
    const above = r.top - gap;
    const needed = this.menu.offsetHeight;
    if (needed > below && above > below) {
      this.menu.style.maxHeight = `${above}px`;
      this.menu.style.top = `${Math.max(gap, r.top - Math.min(needed, above))}px`;
    } else {
      this.menu.style.maxHeight = `${below}px`;
      this.menu.style.top = `${r.bottom}px`;
    }

    const width = this.menu.offsetWidth;
    const left = Math.min(r.left, window.innerWidth - width - gap);
    this.menu.style.left = `${Math.max(gap, left)}px`;
  }

  /** @param {number} i */
  setActive(i) {
    if (i < 0) return;
    this.activeIndex = i;
    for (const el of Array.from(this.menu.children)) {
      el.classList.toggle('is-active', Number(/** @type {HTMLElement} */ (el).dataset.index) === i);
    }
    const item = /** @type {HTMLElement|undefined} */ (this.menu.children[i]);
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
      this.button.setAttribute('aria-activedescendant', item.id);
    }
  }

  /**
   * 从 from 起按 step 方向找下一个可选项，跳过 disabled。找不到返回 -1。
   * @param {number} from @param {number} step @returns {number}
   */
  nextEnabled(from, step) {
    const opts = this.select.options;
    for (let i = from + step; i >= 0 && i < opts.length; i += step) {
      if (!opts[i].disabled) return i;
    }
    return -1;
  }

  /** @param {number} step */
  moveActive(step) {
    const next = this.nextEnabled(this.activeIndex, step);
    if (next >= 0) this.setActive(next);
  }

  /**
   * 选中某项并派发 change（与原生 select 的行为一致：仅在值真正变化时派发）。
   * @param {number} i
   */
  commit(i) {
    const opts = this.select.options;
    if (i < 0 || i >= opts.length || opts[i].disabled) return;
    const changed = readIndex(this.select) !== i;
    writeIndex(this.select, i);
    this.close();
    this.button.focus();
    this.sync();
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** @param {Event} e @returns {number} 事件目标对应的选项下标，-1 表示不在选项上 */
  indexFromEvent(e) {
    const el = /** @type {HTMLElement|null} */ (e.target);
    const item = el?.closest('.cs-option');
    if (!item) return -1;
    return Number(/** @type {HTMLElement} */ (item).dataset.index);
  }

  /** @param {MouseEvent} e */
  onMenuClick(e) {
    const i = this.indexFromEvent(e);
    if (i >= 0) this.commit(i);
  }

  /** @param {PointerEvent} e */
  onMenuHover(e) {
    const i = this.indexFromEvent(e);
    if (i >= 0 && i !== this.activeIndex && !this.select.options[i].disabled) this.setActive(i);
  }

  /** @param {KeyboardEvent} e */
  onKeydown(e) {
    const k = e.key;
    if (!this.isOpen) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        this.open();
      }
      return;
    }
    switch (k) {
      case 'Escape':
        e.preventDefault();
        this.close();
        this.button.focus();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.commit(this.activeIndex);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveActive(-1);
        break;
      case 'Home':
        e.preventDefault();
        this.setActive(this.nextEnabled(-1, 1));
        break;
      case 'End':
        e.preventDefault();
        this.setActive(this.nextEnabled(this.select.options.length, -1));
        break;
      case 'Tab':
        this.close();
        break;
      default:
        if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) this.typeahead(k);
    }
  }

  /** 首字母跳转，1 秒内连续输入视为同一次查询。 @param {string} ch */
  typeahead(ch) {
    this.typeBuffer += ch.toLowerCase();
    clearTimeout(this.typeTimer);
    this.typeTimer = setTimeout(() => {
      this.typeBuffer = '';
    }, 1000);

    const opts = Array.from(this.select.options);
    const start = this.activeIndex + (this.typeBuffer.length > 1 ? 0 : 1);
    for (let n = 0; n < opts.length; n += 1) {
      const i = (start + n) % opts.length;
      const text = (opts[i].textContent || '').trim().toLowerCase();
      if (!opts[i].disabled && text.startsWith(this.typeBuffer)) {
        this.setActive(i);
        return;
      }
    }
  }
}

/** 展开态下的全局关闭逻辑，只装一次。 */
function installGlobalListeners() {
  if (globalsInstalled) return;
  globalsInstalled = true;

  document.addEventListener(
    'pointerdown',
    (e) => {
      const d = openDropdown;
      if (!d) return;
      const t = /** @type {Node} */ (e.target);
      if (d.menu.contains(t) || d.button.contains(t)) return;
      d.close();
    },
    true,
  );
  // 尺寸或滚动一变，fixed 定位就会漂移，直接关掉最省事。
  window.addEventListener('resize', () => openDropdown?.close());
  window.addEventListener('scroll', () => openDropdown?.close(), true);
}

/**
 * 把 root 下所有原生 <select> 换成自定义下拉。可重复调用，已处理过的会跳过。
 * @param {ParentNode} [root]
 * @returns {number} 本次新增强的数量
 */
export function enhanceSelects(root = document) {
  installGlobalListeners();
  let n = 0;
  for (const el of Array.from(root.querySelectorAll('select'))) {
    if (enhanced.has(el)) continue;
    enhanced.add(el);
    new Dropdown(el);
    n += 1;
  }
  return n;
}
