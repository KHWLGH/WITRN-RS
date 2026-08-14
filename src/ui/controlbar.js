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
}

/**
 * PD 采集状态镜像。显示优先级：手动暂停 > 跟随记录等待 > 采集中。
 * 状态本体在 views/pd.js（getPdCaptureState），这里只做 DOM 同步。
 * @param {{ paused: boolean, followSuspended: boolean }} s
 */
export function syncPdCaptureUI(s) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-pause'));
  if (!button) return;

  if (s.paused) {
    button.innerHTML = '<i class="codicon codicon-debug-start"></i>继续';
    button.title = '恢复报文列表刷新';
  } else if (s.followSuspended) {
    button.innerHTML = '<i class="codicon codicon-clock"></i>等待记录';
    button.title = '跟随记录已启用，开始记录后自动继续采集';
  } else {
    button.innerHTML = '<i class="codicon codicon-debug-pause"></i>暂停';
    button.title = '暂停报文列表刷新（后台继续缓冲）';
  }
  button.classList.toggle('is-active', s.paused);
  button.classList.toggle('is-waiting', !s.paused && s.followSuspended);
  button.setAttribute('aria-pressed', String(s.paused));
  button.setAttribute('aria-label', button.title);
}
