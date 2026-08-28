// @ts-check
/**
 * @file 应用内模态对话框 — 替代 tauri dialog 插件的 ask()/message()。
 *
 * 签名与 `window.__TAURI__.dialog` 的同名函数保持一致，调用点迁移只需换 import。
 * 基于原生 <dialog> + showModal()（背景自动 inert、焦点自动捕获）；
 * 极老的 WebKitGTK 无 HTMLDialogElement 时透明回退到插件实现。
 *
 * 并发：同一时刻只显示一个对话框，后到的请求排队串行弹出。
 */

/** @typedef {{ title?: string, kind?: 'info'|'warning'|'error', okLabel?: string, cancelLabel?: string }} DialogOptions */

const supportsDialog = typeof HTMLDialogElement === 'function';

/** @type {HTMLDialogElement|null} */
let dialogEl = null;
/** @type {HTMLElement|null} */
let titleEl = null;
/** @type {HTMLElement|null} */
let iconEl = null;
/** @type {HTMLElement|null} */
let bodyEl = null;
/** @type {HTMLButtonElement|null} */
let okBtn = null;
/** @type {HTMLButtonElement|null} */
let cancelBtn = null;

/** 串行队列：前一个对话框关闭后才弹下一个。 */
let queue = Promise.resolve();

/** kind → Fluent 图标类名与配色 class。 */
const KIND_ICON = {
  info: 'fi-info',
  warning: 'fi-warning',
  error: 'fi-error',
};

function ensureDialog() {
  if (dialogEl) return;

  dialogEl = document.createElement('dialog');
  dialogEl.className = 'fluent-dialog';
  dialogEl.innerHTML = [
    '<div class="fluent-dialog-header">',
    '  <i class="fluent-dialog-icon fi fi-info" aria-hidden="true"></i>',
    '  <h2 class="fluent-dialog-title"></h2>',
    '</div>',
    '<div class="fluent-dialog-body"></div>',
    '<div class="fluent-dialog-actions">',
    '  <button type="button" class="btn btn-accent fluent-dialog-ok"></button>',
    '  <button type="button" class="btn fluent-dialog-cancel"></button>',
    '</div>',
  ].join('\n');
  document.body.appendChild(dialogEl);

  titleEl = dialogEl.querySelector('.fluent-dialog-title');
  iconEl = dialogEl.querySelector('.fluent-dialog-icon');
  bodyEl = dialogEl.querySelector('.fluent-dialog-body');
  okBtn = dialogEl.querySelector('.fluent-dialog-ok');
  cancelBtn = dialogEl.querySelector('.fluent-dialog-cancel');
}

/**
 * 弹出对话框并等待用户选择。
 * @param {string} text
 * @param {DialogOptions} options
 * @param {boolean} withCancel - false = 仅"确定"（message 语义）
 * @returns {Promise<boolean>}
 */
function show(text, options, withCancel) {
  const run = () =>
    new Promise((/** @type {(v: boolean) => void} */ resolve) => {
      ensureDialog();
      const dialog = /** @type {HTMLDialogElement} */ (dialogEl);
      const kind = options.kind ?? 'info';

      if (titleEl) titleEl.textContent = options.title ?? '提示';
      if (bodyEl) bodyEl.textContent = text;
      if (iconEl) {
        iconEl.className = `fluent-dialog-icon fi ${KIND_ICON[kind] ?? KIND_ICON.info}`;
        iconEl.setAttribute('data-kind', kind);
      }
      if (okBtn) {
        okBtn.textContent = options.okLabel ?? '确定';
        okBtn.classList.toggle('btn-danger', kind === 'error');
      }
      if (cancelBtn) {
        cancelBtn.textContent = options.cancelLabel ?? '取消';
        cancelBtn.hidden = !withCancel;
      }

      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      let settled = false;

      /** @param {boolean} result */
      const finish = (result) => {
        if (settled) return;
        settled = true;
        okBtn?.removeEventListener('click', onOk);
        cancelBtn?.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onNativeCancel);
        dialog.removeEventListener('close', onClose);
        if (dialog.open) dialog.close();
        // 应用可能正在退出，焦点恢复失败无所谓
        try {
          opener?.focus();
        } catch {
          /* ignore */
        }
        resolve(result);
      };

      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      /** @param {Event} e */
      const onNativeCancel = (e) => {
        // Esc：交给 close 事件统一收尾（returnValue 为空 → false）
        e.preventDefault();
        finish(false);
      };
      const onClose = () => finish(false);

      okBtn?.addEventListener('click', onOk);
      cancelBtn?.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onNativeCancel);
      dialog.addEventListener('close', onClose);

      dialog.showModal();
      // 破坏性操作默认焦点放在"取消"上，避免回车误确认
      if (withCancel && kind === 'error') cancelBtn?.focus();
      else okBtn?.focus();
    });

  const result = queue.then(run);
  // 队列只关心"上一个已关闭"，吞掉结果与异常
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 确认对话框（确定 / 取消）。
 * @param {string} text
 * @param {DialogOptions} [options]
 * @returns {Promise<boolean>} 用户是否点了"确定"
 */
export async function ask(text, options = {}) {
  if (!supportsDialog) {
    console.warn('[dialog] HTMLDialogElement 不可用，回退到 tauri dialog 插件');
    return window.__TAURI__.dialog.ask(text, options);
  }
  return show(text, options, true);
}

/**
 * 消息对话框（仅"确定"）。
 * @param {string} text
 * @param {DialogOptions} [options]
 * @returns {Promise<void>}
 */
export async function message(text, options = {}) {
  if (!supportsDialog) {
    console.warn('[dialog] HTMLDialogElement 不可用，回退到 tauri dialog 插件');
    return window.__TAURI__.dialog.message(text, options);
  }
  await show(text, options, false);
}
