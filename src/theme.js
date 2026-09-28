// @ts-check
/**
 * @file 主题桥 — 把 CSS 设计令牌暴露给 canvas 侧（uPlot 无法读 CSS 变量），
 * 并负责外观偏好（深色 / 浅色 / 跟随系统）的解析与生效。
 *
 * 通道色 / 图表基建色的唯一定义处是 styles/tokens.css；本模块启动时读入
 * `chartTheme`，chart.js 全部从这里取色，保证图例点 = 复选框色块 = 曲线同源。
 *
 * 换主题：切换 <html data-theme> 后 MutationObserver 触发
 * refreshTheme() 并回调注册方（chart.js 的 applyChartTheme）。
 * data-theme 只写解析后的 dark / light；偏好本身存在 settings.theme
 * 与 localStorage（THEME_STORAGE_KEY，供 theme-boot.js 首屏同步读取）。
 */

import { state } from './state.js';

/** @typedef {typeof chartTheme} ChartTheme */

/** 令牌名 → chartTheme 字段的映射。 */
const TOKEN_MAP = /** @type {const} */ ({
  voltage: '--ch-voltage',
  current: '--ch-current',
  power: '--ch-power',
  temp: '--ch-temp',
  dp: '--ch-dp',
  dn: '--ch-dn',
  cc1: '--ch-cc1',
  cc2: '--ch-cc2',
  tempAxis: '--ch-temp-axis',
  energy: '--ch-energy',
  axisText: '--chart-axis-text',
  grid: '--chart-grid',
  gridMinor: '--chart-grid-minor',
});

/** 令牌缺失时的兜底值（与 tokens.css 暗色值一致，防止 CSS 加载异常时图表全黑）。 */
const FALLBACK = {
  voltage: '#65ade5',
  current: '#34d889',
  power: '#f98845',
  temp: '#dc5e62',
  dp: '#efb839',
  dn: '#c36bd1',
  cc1: '#32c8d1',
  cc2: '#ea66ba',
  tempAxis: '#dc5e62',
  energy: '#d161c4',
  axisText: '#adadad',
  grid: '#666666',
  gridMinor: '#3d3d3d',
};

/** 与 src/theme-boot.js 共用的 localStorage 键。 */
export const THEME_STORAGE_KEY = 'witrn-theme';

/** @typedef {'dark'|'light'|'system'} ThemePreference */
/** @typedef {'dark'|'light'} ResolvedTheme */

/** 图表用到的全部主题色。模块加载时填充，refreshTheme() 原地更新（引用稳定）。 */
export const chartTheme = { ...FALLBACK };

/** 从当前 CSS 令牌重新读入 chartTheme（原地更新，持有引用者无需重新获取）。 */
export function refreshTheme() {
  // node --test 环境无 DOM（测试只 mock 了 getElementById），保持 FALLBACK 值即可
  if (typeof getComputedStyle !== 'function' || !document.documentElement) return;
  const style = getComputedStyle(document.documentElement);
  for (const key of /** @type {(keyof typeof TOKEN_MAP)[]} */ (Object.keys(TOKEN_MAP))) {
    const value = style.getPropertyValue(TOKEN_MAP[key]).trim();
    chartTheme[key] = value !== '' ? value : FALLBACK[key];
  }
}

/**
 * 注册主题变化回调（监听 <html data-theme> 属性）。回调前已完成 refreshTheme()。
 * @param {() => void} callback
 */
export function onThemeChange(callback) {
  const observer = new MutationObserver(() => {
    refreshTheme();
    callback();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/**
 * 把任意输入收成 dark / light / system。
 * @param {unknown} value
 * @returns {ThemePreference}
 */
export function normalizeThemePreference(value) {
  return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark';
}

/**
 * 把偏好解析成实际生效的暗/亮。
 * @param {unknown} preference
 * @param {boolean} systemPrefersDark
 * @returns {ResolvedTheme}
 */
export function resolveTheme(preference, systemPrefersDark) {
  const pref = normalizeThemePreference(preference);
  if (pref === 'light') return 'light';
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return 'dark';
}

/** @type {MediaQueryList|null} */
let systemMql = null;
/** @type {((event: MediaQueryListEvent) => void)|null} */
let systemListener = null;

function detachSystemListener() {
  if (systemMql && systemListener) {
    systemMql.removeEventListener('change', systemListener);
  }
  systemMql = null;
  systemListener = null;
}

/**
 * @returns {boolean}
 */
function systemPrefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 写解析后的 data-theme，并镜像偏好到 localStorage 供 theme-boot.js 首屏读取。
 * @param {unknown} preference
 * @returns {ThemePreference}
 */
export function applyThemePreference(preference) {
  const pref = normalizeThemePreference(preference);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch {
      /* 隐私模式等写失败不影响本次生效 */
    }
  }

  if (typeof document === 'undefined' || !document.documentElement) return pref;

  const resolved = resolveTheme(pref, systemPrefersDark());
  document.documentElement.setAttribute('data-theme', resolved);
  detachSystemListener();
  if (pref === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    systemListener = () => {
      document.documentElement.setAttribute('data-theme', resolveTheme('system', mql.matches));
    };
    mql.addEventListener('change', systemListener);
    systemMql = mql;
  }

  return pref;
}

/** 回显设置页主题单选（loadSettings / resetSettings 共用）。 */
export function echoThemeUI() {
  if (typeof document === 'undefined') return;
  const pref = normalizeThemePreference(state.settings.theme);
  const dark = /** @type {HTMLInputElement|null} */ (document.getElementById('theme-choice-dark'));
  const light = /** @type {HTMLInputElement|null} */ (document.getElementById('theme-choice-light'));
  const system = /** @type {HTMLInputElement|null} */ (document.getElementById('theme-choice-system'));
  if (dark) dark.checked = pref === 'dark';
  if (light) light.checked = pref === 'light';
  if (system) system.checked = pref === 'system';
}

refreshTheme();
