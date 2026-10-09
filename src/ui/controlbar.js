// @ts-check
/**
 * @file 常驻命令栏状态镜像。
 *
 * 这里仅负责把业务状态同步到命令栏控件，业务动作仍由 app.js、data.js、
 * temperature.js 和 views/pd.js 负责，避免这些模块重复修改同一组 DOM。
 */

import { t } from '../i18n.js';
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

/** Update existing icon/text nodes so language changes retain the button's DOM.
 * @param {HTMLButtonElement} button @param {string} icon @param {string} text */
function setButtonLabel(button, icon, text) {
  button.querySelector?.('i.fi')?.setAttribute('class', `fi fi-${icon}`);
  const label = button.querySelector?.('span');
  if (label) label.textContent = text;
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

  const linked = s.followPd ? `；${t('followRecordingHint')}` : '';
  if (s.recording) {
    setButtonLabel(button, 'pause', t('pauseRecording'));
    setTip(button, `${t('pauseRecording')}，${t('pauseRecordingHint')}${linked}`);
  } else if (!s.connected) {
    setButtonLabel(button, 'record', s.hasData ? t('continueRecording') : t('startRecording'));
    setTip(button, t('pleaseConnect'));
  } else if (s.hasData) {
    setButtonLabel(button, 'record', t('continueRecording'));
    setTip(button, `${t('continueRecordingHint')}${linked}`);
  } else {
    setButtonLabel(button, 'record', t('startRecording'));
    setTip(button, `${t('startRecording')}${linked}`);
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
  setTip(button, enabled ? t('disableAutoPause') : t('enableAutoPause'));
}

/** @param {boolean} connected @param {boolean} [busy=false] */
export function syncTempUI(connected, busy = false) {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-temp-toggle'));
  const label = document.getElementById('temp-toggle-label');
  if (!button) return;

  const text = busy
    ? connected
      ? `${t('temperatureService')} ${t('connected')}`
      : t('tempConnecting')
    : connected
      ? `${t('temperatureService')} ${t('connected')}`
      : t('temperatureService');
  const action = connected
    ? `${t('disconnect')} ${t('temperatureService')}`
    : `${t('connect')} ${t('temperatureService')}`;
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
    setButtonLabel(button, 'pause', t('pauseRecording'));
    setTip(button, t('pdFollowPause'));
  } else if (follow) {
    setButtonLabel(button, 'record', t('startRecording'));
    setTip(button, opts?.connected ? t('pdFollowStart') : t('pleaseConnect'));
  } else if (s.paused) {
    setButtonLabel(button, 'play', t('continueRecording'));
    setTip(button, t('pdResumeList'));
  } else {
    setButtonLabel(button, 'pause', t('pauseRecording'));
    setTip(button, t('pdPauseList'));
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
    setTip(pdClear, followEnabled ? t('clearMessagesLinked') : t('clearMessages'));
  }

  const chartClear = document.getElementById('btn-clear-chart');
  if (chartClear) {
    setTip(chartClear, followEnabled ? t('clearChartLinked') : t('clearChart'));
  }
}

const MONITOR_OVERFLOW_IDS = ['btn-export', 'btn-import', 'btn-clear-chart'];
/** @type {{ setLabel: (id: string, label: string) => void }|null} */
let overflowMenu = null;

/**
 * 监控命令栏溢出：宽度不够时把导出 / 导入 / 一键重置收进 ⋯ 菜单。
 * @param {{ exportCSV: (withTemp: boolean) => void }} actions
 */
export function initCommandOverflow(actions) {
  const bar = document.querySelector('#view-monitor .commandbar');
  const overflowBtn = document.getElementById('btn-cmd-overflow');
  if (!(bar instanceof HTMLElement) || !overflowBtn) return;

  overflowMenu = createMenu(overflowBtn, [
    {
      id: 'overflow-export-no-temp',
      label: `${t('exportCsv')}（${t('withoutTemperature')}）`,
      icon: 'export',
      onSelect: () => actions.exportCSV(false),
    },
    {
      id: 'overflow-export-with-temp',
      label: `${t('exportCsv')}（${t('withTemperature')}）`,
      icon: 'export',
      onSelect: () => actions.exportCSV(true),
    },
    {
      id: 'overflow-import',
      label: t('importCsv'),
      icon: 'download',
      onSelect: () => document.getElementById('btn-import')?.click(),
    },
    {
      id: 'overflow-clear',
      label: t('reset'),
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

/** Refresh labels in the overflow menu after a language change. */
export function refreshCommandOverflowLanguage() {
  if (!overflowMenu) return;
  overflowMenu.setLabel('overflow-export-no-temp', `${t('exportCsv')} (${t('withoutTemperature')})`);
  overflowMenu.setLabel('overflow-export-with-temp', `${t('exportCsv')} (${t('withTemperature')})`);
  overflowMenu.setLabel('overflow-import', t('importCsv'));
  overflowMenu.setLabel('overflow-clear', t('reset'));
}
