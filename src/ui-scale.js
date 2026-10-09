// @ts-check
import { t } from './i18n.js';
/**
 * @file 界面等比缩放 — 设置项 uiScalePercent 的钳位与生效。
 *
 * 主路径走 Tauri WebView setZoom（布局视口随比例变化，100vh / media query /
 * ResizeObserver / PD 行高都仍以 CSS 像素计）。API 不可用时回退到
 * documentElement.zoom，并打 data-ui-scale-css 让 CSS 补偿 100vh。
 */

export const UI_SCALE_MIN = 50;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 5;
export const UI_SCALE_DEFAULT = 100;

/**
 * 把任意输入收成 50–200、步进 5 的整数百分比。
 * @param {unknown} value
 * @returns {number}
 */
export function clampUiScalePercent(value) {
  if (value == null || value === '') return UI_SCALE_DEFAULT;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT;
  const rounded = Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, rounded));
}

/**
 * @returns {((factor: number) => Promise<void>) | null}
 */
function getZoomSetter() {
  const api = /** @type {any} */ (typeof window !== 'undefined' ? window.__TAURI__ : null);
  if (!api) return null;
  const webview = api.webview?.getCurrentWebview?.();
  if (typeof webview?.setZoom === 'function') {
    return (factor) => webview.setZoom(factor);
  }
  const wvWindow = api.webviewWindow?.getCurrent?.();
  if (typeof wvWindow?.setZoom === 'function') {
    return (factor) => wvWindow.setZoom(factor);
  }
  return null;
}

/** @param {number} percent */
function echoScaleControls(percent) {
  if (typeof document === 'undefined') return;
  const slider = /** @type {HTMLInputElement|null} */ (document.getElementById('ui-scale'));
  if (slider && slider.value !== String(percent)) slider.value = String(percent);
  const label = document.getElementById('ui-scale-value');
  if (label) label.textContent = `${percent}%`;
}

/** @param {boolean} enabled */
function setCssZoomFallback(enabled, factor) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (enabled) {
    root.style.setProperty('zoom', String(factor));
    root.setAttribute('data-ui-scale-css', '');
  } else {
    root.style.removeProperty('zoom');
    root.removeAttribute('data-ui-scale-css');
  }
}

function notifyLayout() {
  if (typeof window === 'undefined') return;
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

/** 丢弃过期的异步 setZoom，避免拖动/连按期间乱序回写。 */
let applySeq = 0;
/** 上次真正落到 WebView/CSS 的因子；相同则跳过，避免无谓重排。 */
let appliedFactor = /** @type {number|null} */ (null);

/**
 * 只更新百分比读数，不改 WebView 缩放。拖动滑条时用这个：
 * 缩放整页会改变滑条几何，原生 range 再按新几何跟指针，就会抽搐。
 * @param {unknown} percent
 * @returns {number}
 */
export function previewUiScalePercent(percent) {
  const clamped = clampUiScalePercent(percent);
  if (typeof document === 'undefined') return clamped;
  const label = document.getElementById('ui-scale-value');
  if (label) label.textContent = `${clamped}%`;
  return clamped;
}

/**
 * 应用缩放并回显滑条。返回实际生效的百分比。
 * @param {unknown} percent
 * @returns {Promise<number>}
 */
export async function applyUiScale(percent) {
  const clamped = clampUiScalePercent(percent);
  const factor = clamped / 100;
  echoScaleControls(clamped);

  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ui-scale', String(factor));
  }

  if (appliedFactor === factor) return clamped;

  const seq = ++applySeq;

  const setZoom = getZoomSetter();
  if (setZoom) {
    try {
      await setZoom(factor);
      if (seq !== applySeq) return clamped;
      appliedFactor = factor;
      setCssZoomFallback(false, factor);
      notifyLayout();
      return clamped;
    } catch {
      /* 权限未授或运行时拒绝时走 CSS 回退 */
    }
  }

  if (seq !== applySeq) return clamped;
  appliedFactor = factor;
  setCssZoomFallback(true, factor);
  notifyLayout();
  return clamped;
}

/** 在外观卡说明里附上当前系统缩放，方便对照。 */
export function fillUiScaleHint() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const hint = document.getElementById('ui-scale-hint');
  if (!hint) return;
  const dpr = window.devicePixelRatio;
  const sys = Math.round((Number.isFinite(dpr) ? dpr : 1) * 100);
  hint.textContent = t('uiScaleCurrent', { percent: sys });
}
