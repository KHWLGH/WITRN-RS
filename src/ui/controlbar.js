// @ts-check
/**
 * @file 常驻命令栏状态镜像。
 *
 * 这里仅负责把业务状态同步到命令栏控件，业务动作仍由 app.js、
 * temperature.js 和 settings.js 负责，避免这些模块重复修改同一组 DOM。
 */

/** @param {boolean} enabled */
export function syncAutoPauseUI(enabled) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-auto-pause-command'));
  if (!button) return;

  button.setAttribute('aria-pressed', String(enabled));
  button.classList.toggle('is-active', enabled);
  button.title = enabled ? '停用自动暂停' : '启用自动暂停';
  button.setAttribute('aria-label', button.title);
}

/** @param {boolean} connected @param {boolean} [busy=false] */
export function syncTempUI(connected, busy = false) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-temp-toggle'));
  const label = document.getElementById('temp-toggle-label');
  const icon = document.getElementById('temp-toggle-icon');
  if (!button) return;

  const text = busy ? (connected ? '温度已连接' : '连接中...') : connected ? '温度已连接' : '温度服务';
  const action = connected ? '断开温度服务' : '连接温度服务';
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.setAttribute('aria-pressed', String(connected));
  button.classList.toggle('is-active', connected);
  button.title = busy ? text : action;
  button.setAttribute('aria-label', button.title);
  if (label) label.textContent = text;
  if (icon) {
    icon.classList.toggle('codicon-plug', !connected);
    icon.classList.toggle('codicon-check', connected);
  }
}
