// @ts-check
/**
 * @file 非阻塞 toast 通知（Fluent InfoBar 风格），替代 window.alert()。
 *
 * 右下角堆叠，最多同显 3 条，超出的排队；error 默认常驻（需手动关闭），
 * 其余 4 秒自动消失，悬停暂停计时。容器优先复用 index.html 里的
 * #toast-region（页面加载即存在，aria-live 对读屏器更可靠），缺失时兜底创建。
 */

import { errorText, onLanguageChange, t } from '../i18n.js';

/** @typedef {'info'|'success'|'warning'|'error'} ToastSeverity */
/** @typedef {{ label: string|(() => string), onClick: () => void | boolean | Promise<void | boolean>, disabled?: () => boolean }} ToastAction */
/** @typedef {{ severity?: ToastSeverity, duration?: number, action?: ToastAction, actions?: ToastAction[] }} ToastOptions */
/** @typedef {string|(() => string)} ToastText */
/** @typedef {{ dismiss: () => void, refreshActions: () => void, refreshLanguage: () => void, setText: (text: ToastText) => void }} ToastHandle */
/** @typedef {{ text: ToastText, options: ToastOptions, handle: ToastHandle }} QueuedToast */

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 4000;

/** severity → Fluent 图标类名。 */
const SEVERITY_ICON = {
  info: 'fi-info',
  success: 'fi-success',
  warning: 'fi-warning',
  error: 'fi-error',
};

/** @type {HTMLElement|null} */
let regionEl = null;
/** @type {QueuedToast[]} */
const pending = [];
let visibleCount = 0;
/** @type {Set<import('./toast.js').ToastHandle>} */
const activeHandles = new Set();

function ensureRegion() {
  if (regionEl?.isConnected) return regionEl;
  regionEl = document.getElementById('toast-region');
  if (!regionEl) {
    regionEl = document.createElement('div');
    regionEl.id = 'toast-region';
    regionEl.className = 'toast-region';
    regionEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(regionEl);
  }
  return regionEl;
}

/**
 * @param {QueuedToast} notification
 */
function render({ text, options, handle }) {
  const region = ensureRegion();
  const severity = options.severity ?? 'info';
  const duration = options.duration ?? (severity === 'error' ? 0 : DEFAULT_DURATION);

  const el = document.createElement('div');
  el.className = `toast toast-${severity}`;
  if (severity === 'error') el.setAttribute('role', 'alert');

  const icon = document.createElement('i');
  icon.className = `toast-icon fi ${SEVERITY_ICON[severity]}`;
  icon.setAttribute('aria-hidden', 'true');
  el.appendChild(icon);

  const textEl = document.createElement('div');
  textEl.className = 'toast-text';
  let currentText = text;
  textEl.textContent = typeof currentText === 'function' ? currentText() : currentText;
  el.appendChild(textEl);

  const actions = options.actions ?? (options.action ? [options.action] : []);
  const actionGroup = document.createElement('div');
  actionGroup.className = 'toast-actions';
  /** @type {{ button: HTMLButtonElement, action: ToastAction }[]} */
  const actionButtons = [];
  let busy = false;
  for (const action of actions) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'btn toast-action';
    actionBtn.textContent = typeof action.label === 'function' ? action.label() : action.label;
    actionButtons.push({ button: actionBtn, action });
    actionBtn.addEventListener('click', async () => {
      if (dismissed || busy || action.disabled?.()) return;
      busy = true;
      stopTimer();
      refreshActions();
      try {
        if ((await action.onClick()) !== false) dismiss();
      } catch (error) {
        console.error('通知操作失败:', error);
        toast.error(() => t('operationFailed', { detail: errorText(error) }));
      } finally {
        busy = false;
        refreshActions();
        startTimer();
      }
    });
    actionGroup.appendChild(actionBtn);
  }
  if (actions.length) el.appendChild(actionGroup);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.title = t('close');
  closeBtn.setAttribute('aria-label', t('closeNotification'));
  closeBtn.innerHTML = '<i class="fi fi-dismiss" aria-hidden="true"></i>';
  closeBtn.addEventListener('click', () => dismiss());
  el.appendChild(closeBtn);

  /** @type {number|null} */
  let timer = null;
  let dismissed = false;
  let hovered = false;

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const refreshActions = () => {
    for (const { button, action } of actionButtons) {
      button.textContent = typeof action.label === 'function' ? action.label() : action.label;
      button.disabled = dismissed || busy || !!action.disabled?.();
    }
    closeBtn.disabled = dismissed || busy;
    el.setAttribute('aria-busy', String(busy));
  };

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    activeHandles.delete(handle);
    stopTimer();
    refreshActions();
    el.classList.add('toast-leaving');
    // 与 components.css 的 toast 出场动画时长一致
    setTimeout(() => {
      el.remove();
      visibleCount--;
      drainQueue();
    }, 160);
  };

  const startTimer = () => {
    stopTimer();
    if (!dismissed && !busy && !hovered && duration > 0) timer = window.setTimeout(dismiss, duration);
  };
  el.addEventListener('mouseenter', () => {
    hovered = true;
    stopTimer();
  });
  el.addEventListener('mouseleave', () => {
    hovered = false;
    startTimer();
  });

  handle.dismiss = dismiss;
  handle.refreshActions = refreshActions;
  handle.refreshLanguage = () => {
    textEl.textContent = typeof currentText === 'function' ? currentText() : currentText;
    refreshActions();
    closeBtn.title = t('close');
    closeBtn.setAttribute('aria-label', t('closeNotification'));
  };
  handle.setText = (message) => {
    currentText = message;
    textEl.textContent = typeof message === 'function' ? message() : message;
  };
  refreshActions();
  activeHandles.add(handle);
  region.appendChild(el);
  visibleCount++;
  startTimer();
}

function drainQueue() {
  while (visibleCount < MAX_VISIBLE && pending.length > 0) {
    const next = pending.shift();
    if (next) render(next);
  }
}

/**
 * 显示一条 toast。
 * @param {ToastText} text
 * @param {ToastOptions} [options]
 */
export function toast(text, options = {}) {
  /** @type {ToastHandle} */
  const handle = {
    dismiss: () => {
      const index = pending.findIndex((item) => item.handle === handle);
      if (index >= 0) pending.splice(index, 1);
    },
    refreshActions: () => {},
    refreshLanguage: () => {},
    setText: (message) => {
      notification.text = message;
    },
  };
  const notification = { text, options, handle };
  if (visibleCount >= MAX_VISIBLE) {
    pending.push(notification);
  } else {
    render(notification);
  }
  return handle;
}

/** @param {ToastText} text @param {ToastOptions} [options] */
toast.info = (text, options = {}) => toast(text, { ...options, severity: 'info' });
/** @param {ToastText} text @param {ToastOptions} [options] */
toast.success = (text, options = {}) => toast(text, { ...options, severity: 'success' });
/** @param {ToastText} text @param {ToastOptions} [options] */
toast.warning = (text, options = {}) => toast(text, { ...options, severity: 'warning' });
/** @param {ToastText} text @param {ToastOptions} [options] */
toast.error = (text, options = {}) => toast(text, { ...options, severity: 'error' });

onLanguageChange(() => {
  for (const handle of activeHandles) handle.refreshLanguage();
});
