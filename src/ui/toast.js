// @ts-check
/**
 * @file 非阻塞 toast 通知（Fluent InfoBar 风格），替代 window.alert()。
 *
 * 右下角堆叠，最多同显 3 条，超出的排队；error 默认常驻（需手动关闭），
 * 其余 4 秒自动消失，悬停暂停计时。容器优先复用 index.html 里的
 * #toast-region（页面加载即存在，aria-live 对读屏器更可靠），缺失时兜底创建。
 */

/** @typedef {'info'|'success'|'warning'|'error'} ToastSeverity */
/** @typedef {{ severity?: ToastSeverity, duration?: number, action?: { label: string, onClick: () => void } }} ToastOptions */

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 4000;

/** severity → codicon 类名。 */
const SEVERITY_ICON = {
  info: 'codicon-info',
  success: 'codicon-pass',
  warning: 'codicon-warning',
  error: 'codicon-error',
};

/** @type {HTMLElement|null} */
let regionEl = null;
/** @type {{ text: string, options: ToastOptions }[]} */
const pending = [];
let visibleCount = 0;

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
 * @param {string} text
 * @param {ToastOptions} options
 */
function render(text, options) {
  const region = ensureRegion();
  const severity = options.severity ?? 'info';
  const duration = options.duration ?? (severity === 'error' ? 0 : DEFAULT_DURATION);

  const el = document.createElement('div');
  el.className = `toast toast-${severity}`;
  if (severity === 'error') el.setAttribute('role', 'alert');

  const icon = document.createElement('i');
  icon.className = `toast-icon codicon ${SEVERITY_ICON[severity]}`;
  icon.setAttribute('aria-hidden', 'true');
  el.appendChild(icon);

  const textEl = document.createElement('div');
  textEl.className = 'toast-text';
  textEl.textContent = text;
  el.appendChild(textEl);

  if (options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'btn toast-action';
    actionBtn.textContent = options.action.label;
    const onClick = options.action.onClick;
    actionBtn.addEventListener('click', () => {
      onClick();
      dismiss();
    });
    el.appendChild(actionBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.title = '关闭';
  closeBtn.setAttribute('aria-label', '关闭通知');
  closeBtn.innerHTML = '<i class="codicon codicon-close" aria-hidden="true"></i>';
  closeBtn.addEventListener('click', () => dismiss());
  el.appendChild(closeBtn);

  /** @type {number|null} */
  let timer = null;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (timer !== null) clearTimeout(timer);
    el.classList.add('toast-leaving');
    // 与 components.css 的 toast 出场动画时长一致
    setTimeout(() => {
      el.remove();
      visibleCount--;
      drainQueue();
    }, 160);
  };

  const startTimer = () => {
    if (duration > 0) timer = window.setTimeout(dismiss, duration);
  };
  el.addEventListener('mouseenter', () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
  el.addEventListener('mouseleave', startTimer);

  region.appendChild(el);
  visibleCount++;
  startTimer();
}

function drainQueue() {
  while (visibleCount < MAX_VISIBLE && pending.length > 0) {
    const next = pending.shift();
    if (next) render(next.text, next.options);
  }
}

/**
 * 显示一条 toast。
 * @param {string} text
 * @param {ToastOptions} [options]
 */
export function toast(text, options = {}) {
  if (visibleCount >= MAX_VISIBLE) {
    pending.push({ text, options });
    return;
  }
  render(text, options);
}

/** @param {string} text @param {ToastOptions} [options] */
toast.info = (text, options = {}) => toast(text, { ...options, severity: 'info' });
/** @param {string} text @param {ToastOptions} [options] */
toast.success = (text, options = {}) => toast(text, { ...options, severity: 'success' });
/** @param {string} text @param {ToastOptions} [options] */
toast.warning = (text, options = {}) => toast(text, { ...options, severity: 'warning' });
/** @param {string} text @param {ToastOptions} [options] */
toast.error = (text, options = {}) => toast(text, { ...options, severity: 'error' });
