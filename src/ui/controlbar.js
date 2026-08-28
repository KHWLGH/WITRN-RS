// @ts-check
/**
 * @file 常驻命令栏状态镜像。
 *
 * 这里仅负责把业务状态同步到命令栏控件，业务动作仍由 app.js、data.js、
 * temperature.js 和 views/pd.js 负责，避免这些模块重复修改同一组 DOM。
 */

import { fi } from './icons.js';
import { createMenu } from './menu.js';

/**
 * 设置悬浮提示。本应用统一用原生 title（compact.css 的图标化档依赖它），
 * 从 JS 写入时一律镜像到 aria-label。
 * @param {HTMLElement} el @param {string} text
 */
function setTip(el, text) {
  el.title = text;
  el.setAttribute('aria-label', text);
}

/**
 * 记录按钮状态镜像（命令栏唯一的实心强调按钮）。
 *
 * 「停止后再开始」本就是续接同一条时间线（见 data.js 的 recordingBaseSeconds），
 * 所以文案是 开始 / 继续 / 暂停，而不是 开始 / 停止。
 * @param {{ connected: boolean, recording: boolean, hasData: boolean, followPd?: boolean }} s
 */
export function syncRecordUI(s) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-record-toggle'));
  if (!button) return;

  const linked = s.followPd ? '；跟随记录已开启，同时控制 PD 报文采集' : '';
  if (s.recording) {
    button.innerHTML = `${fi('pause')}暂停记录`;
    setTip(button, `暂停记录，已记录的数据保留，可随时继续${linked}`);
  } else if (!s.connected) {
    button.innerHTML = `${fi('record')}${s.hasData ? '继续记录' : '开始记录'}`;
    setTip(button, '请先连接设备');
  } else if (s.hasData) {
    button.innerHTML = `${fi('record')}继续记录`;
    setTip(button, `继续记录，续接当前时间线，不会清空已有数据${linked}`);
  } else {
    button.innerHTML = `${fi('record')}开始记录`;
    setTip(button, `开始记录${linked}`);
  }

  button.disabled = !s.connected;
  button.classList.toggle('is-recording', s.recording);
  button.setAttribute('aria-pressed', String(s.recording));
}

/** @param {boolean} enabled */
export function syncAutoPauseUI(enabled) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-auto-pause-command'));
  if (!button) return;

  button.setAttribute('aria-pressed', String(enabled));
  button.classList.toggle('is-active', enabled);
  setTip(button, enabled ? '停用自动暂停' : '启用自动暂停');
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
  setTip(button, busy ? text : action);
  if (label) label.textContent = text;
}

/**
 * PD 采集按钮状态镜像。
 *
 * 跟随记录开启时这颗按钮就是主监控的记录开关（views/pd.js 的点击处理直接切换录制），
 * 外观也随之切换成与监控面板同款的实心强调按钮——视觉上直说「这两个是同一个开关」；
 * 关闭时退回本地的暂停 / 继续（仅停止列表刷新，报文继续进缓冲）。
 *
 * 按钮的 disabled 由 views/pd.js 掌握（懒初始化前不可交互），这里只管外观与提示。
 * @param {{ paused: boolean, followSuspended: boolean }} s
 * @param {{ followEnabled: boolean, connected: boolean, recording: boolean }} [opts]
 */
export function syncPdCaptureUI(s, opts) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-pause'));
  if (!button) return;

  const follow = opts?.followEnabled ?? false;
  const recording = follow && !!opts?.recording;

  if (follow && recording) {
    button.innerHTML = `${fi('pause')}暂停记录`;
    setTip(button, '暂停记录（跟随记录已开启：同时暂停主监控记录与 PD 采集）');
  } else if (follow) {
    button.innerHTML = `${fi('record')}开始记录`;
    setTip(
      button,
      opts?.connected ? '开始记录（跟随记录已开启：同时启动主监控记录并开始采集 PD 报文）' : '请先连接设备',
    );
  } else if (s.paused) {
    button.innerHTML = `${fi('play')}继续`;
    setTip(button, '恢复报文列表刷新');
  } else {
    button.innerHTML = `${fi('pause')}暂停`;
    setTip(button, '暂停报文列表刷新（后台继续缓冲）');
  }

  button.classList.toggle('cmd-primary-btn', follow);
  button.classList.toggle('is-recording', recording);
  button.classList.toggle('is-active', !follow && s.paused);
  button.setAttribute('aria-pressed', String(follow ? recording : s.paused));
}

/**
 * 跟随记录的联动后果提示：两侧清空按钮的 title 随开关切换，
 * 让用户在按下去之前就知道会不会连带清掉另一侧。
 * @param {boolean} followEnabled
 */
export function syncFollowLinkageUI(followEnabled) {
  const pdClear = document.getElementById('btn-pd-clear');
  if (pdClear) {
    setTip(
      pdClear,
      followEnabled ? '清空报文列表（跟随记录已开启：同时重置监控图表、统计与累计能量）' : '清空报文列表',
    );
  }

  const chartClear = document.getElementById('btn-clear-chart');
  if (chartClear) {
    setTip(
      chartClear,
      followEnabled ? '清空图表并重置统计与能量（跟随记录已开启：同时清空 PD 报文列表）' : '清空图表并重置统计与能量',
    );
  }
}

const MONITOR_OVERFLOW_IDS = ['btn-export', 'btn-import', 'btn-clear-chart'];

/**
 * 监控命令栏溢出：宽度不够时把导出 / 导入 / 一键重置收进 ⋯ 菜单。
 * @param {{ exportCSV: (withTemp: boolean) => void }} actions
 */
export function initCommandOverflow(actions) {
  const bar = document.querySelector('#view-monitor .commandbar');
  const overflowBtn = document.getElementById('btn-cmd-overflow');
  if (!(bar instanceof HTMLElement) || !overflowBtn) return;

  createMenu(overflowBtn, [
    {
      id: 'overflow-export-no-temp',
      label: '导出CSV（不带温度）',
      icon: 'export',
      onSelect: () => actions.exportCSV(false),
    },
    {
      id: 'overflow-export-with-temp',
      label: '导出CSV（带温度）',
      icon: 'export',
      onSelect: () => actions.exportCSV(true),
    },
    {
      id: 'overflow-import',
      label: '导入CSV',
      icon: 'download',
      onSelect: () => document.getElementById('btn-import')?.click(),
    },
    {
      id: 'overflow-clear',
      label: '一键重置',
      icon: 'clear',
      onSelect: () => {
        const btn = document.getElementById('btn-clear-chart');
        if (btn instanceof HTMLButtonElement && !btn.disabled) btn.click();
      },
    },
  ]);

  /** @param {boolean} overflowed */
  const applyHidden = (overflowed) => {
    for (const id of MONITOR_OVERFLOW_IDS) {
      const el = document.getElementById(id);
      if (el) el.hidden = overflowed;
    }
    overflowBtn.hidden = !overflowed;
  };

  const measure = () => {
    applyHidden(false);
    applyHidden(bar.scrollWidth > bar.clientWidth + 1);
  };

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(bar);
  window.addEventListener('resize', measure);
  measure();
}
