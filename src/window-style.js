// @ts-check
/** 窗口外观偏好；只换皮肤，不改变真实平台、原生装饰或窗口动作。 */

/** @typedef {'auto'|'windows'|'macos'} WindowStylePreference */

/** 与 theme-boot.js 的首屏镜像键保持一致；LazyStore 为最终真值。 */
export const WINDOW_STYLE_STORAGE_KEY = 'lapower-window-style';

/** @param {unknown} value @returns {WindowStylePreference} */
export function normalizeWindowStyle(value) {
  return value === 'windows' || value === 'macos' ? value : 'auto';
}

/**
 * @param {unknown} preference
 * @param {unknown} os 真实平台（data-os），不能由风格偏好覆盖。
 * @returns {'windows'|'macos'}
 */
export function resolveWindowStyle(preference, os) {
  const pref = normalizeWindowStyle(preference);
  return pref === 'auto' ? (os === 'macos' ? 'macos' : 'windows') : pref;
}

/**
 * 同步切换现有节点的 CSS 皮肤；不重建按钮、不注册事件、不触碰材质。
 * @param {unknown} preference
 * @returns {WindowStylePreference}
 */
export function applyWindowStyle(preference) {
  const pref = normalizeWindowStyle(preference);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(WINDOW_STYLE_STORAGE_KEY, pref);
  } catch {
    /* 镜像不可用不影响 LazyStore 持久化。 */
  }
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const style = resolveWindowStyle(pref, root.getAttribute('data-os'));
    if (root.getAttribute('data-window-style') !== style) root.setAttribute('data-window-style', style);
  }
  return pref;
}

/** loadSettings / resetSettings 共用的设置回显。
 * @param {unknown} preference
 */
export function echoWindowStyleUI(preference) {
  if (typeof document === 'undefined') return;
  const pref = normalizeWindowStyle(preference);
  for (const choice of ['auto', 'windows', 'macos']) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(`window-style-${choice}`));
    if (input) input.checked = choice === pref;
  }
}
