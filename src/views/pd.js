// @ts-check
/**
 * @file PD 协议分析视图 — pd-data 事件的接收、环形缓冲与批量渲染。
 *
 * pd-data 在后端不节流（每个 0xFE 报文即时发射），因此：
 * - 监听在 app.js 启动时就注册（插拔瞬间的握手报文最有价值，不等用户打开 Tab）；
 * - 环形缓冲封顶 2000 条，溢出覆盖最旧并计数；
 * - DOM 追加走 rAF 批处理 + DocumentFragment；视图隐藏时完全跳过 DOM 工作，
 *   重新显示时整体重建（syncPdView）。
 * - 行的字段树在首次展开时才构建（未展开的行只有一行扁平 DOM）。
 */

import { childrenOf, createRing, matchesFilter, summarize } from '../pd-model.js';
import { debouncedSaveSettings } from '../settings.js';
import { state } from '../state.js';

/** @typedef {import('../pd-model.js').PdMeta} PdMeta */
/** @typedef {import('../pd-model.js').PdEntry} PdEntry */
/** @typedef {import('../pd-model.js').PdDivider} PdDivider */

const RING_CAP = 2000;

/** @type {ReturnType<typeof createRing<PdEntry|PdDivider>>} */
const ring = createRing(RING_CAP);

let paused = false;
let bufferedWhilePaused = 0;
/** @type {(PdEntry|PdDivider)[]} */
let pendingEntries = [];
let renderScheduled = false;
let initialized = false;

// ─── 摘取 DOM ────────────────────────────────────────────────────────────────

const els = {
  /** @returns {HTMLElement|null} */
  list: () => document.getElementById('pd-list'),
  empty: () => document.getElementById('pd-empty'),
  counter: () => document.getElementById('pd-counter'),
  view: () => document.getElementById('view-pd'),
  pauseBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-pause')),
  clearBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-clear')),
  filter: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-filter')),
  hideGoodCrc: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-hide-goodcrc')),
  autoscroll: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-autoscroll')),
  followRecording: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-follow-recording')),
};

function currentFilterText() {
  return els.filter()?.value ?? '';
}

function currentHideGoodCrc() {
  return els.hideGoodCrc()?.checked ?? true;
}

function autoscrollEnabled() {
  return els.autoscroll()?.checked ?? true;
}

function followRecordingEnabled() {
  return state.settings.pdFollowRecording;
}

function viewHidden() {
  return els.view()?.hidden ?? true;
}

// ─── 摄入 ────────────────────────────────────────────────────────────────────

/**
 * app.js 的 pd-data 监听器入口。
 * @param {PdMeta} meta
 */
export function ingestPdData(meta) {
  if (followRecordingEnabled() && !state.isRecording) return;
  /** @type {PdEntry} */
  const entry = { t: Date.now(), ...summarize(meta), meta };
  ring.push(entry);
  if (paused) {
    bufferedWhilePaused++;
    updateCounter();
    return;
  }
  if (viewHidden()) return; // 重新显示时 syncPdView 整体重建
  pendingEntries.push(entry);
  scheduleRender();
}

/** 当前 PD 环形缓冲中的条目数（用于诊断与测试）。 */
export function getPdBufferLength() {
  return ring.length;
}

/** 设备断开时插入分隔行，区分两次会话。 */
export function markPdDisconnect() {
  if (ring.length === 0) return;
  /** @type {PdDivider} */
  const divider = { t: Date.now(), divider: true };
  ring.push(divider);
  if (!paused && !viewHidden()) {
    pendingEntries.push(divider);
    scheduleRender();
  }
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    flushPending();
  });
}

function flushPending() {
  const list = els.list();
  if (!list) return;
  const entries = pendingEntries;
  pendingEntries = [];
  if (entries.length === 0) {
    updateCounter();
    return;
  }

  const filterText = currentFilterText();
  const hideGoodCrc = currentHideGoodCrc();
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    if (matchesFilter(entry, filterText, hideGoodCrc)) fragment.appendChild(buildRow(entry));
  }

  const follow = autoscrollEnabled();
  // appendChild 会把节点从 fragment 搬空，计数必须在追加前取
  const added = fragment.childNodes.length;
  if (added > 0) {
    list.appendChild(fragment);
    while (list.children.length > RING_CAP) list.children[0].remove();
  }
  // 先解除 hidden 再滚动：列表 display:none 时 scrollHeight 恒为 0，赋值会被吞掉
  updateEmptyState();
  if (follow && added > 0) list.scrollTop = list.scrollHeight;
  updateCounter();
}

/** 从环形缓冲整体重建列表（过滤变化 / 视图重新显示 / 恢复暂停）。 */
function rebuildAll() {
  const list = els.list();
  if (!list) return;
  pendingEntries = [];
  const filterText = currentFilterText();
  const hideGoodCrc = currentHideGoodCrc();
  const fragment = document.createDocumentFragment();
  for (const entry of ring.toArray()) {
    if (matchesFilter(entry, filterText, hideGoodCrc)) fragment.appendChild(buildRow(entry));
  }
  list.replaceChildren(fragment);
  // 同 flushPending：先解除 hidden 再滚动
  updateEmptyState();
  if (autoscrollEnabled()) list.scrollTop = list.scrollHeight;
  updateCounter();
}

/**
 * @param {PdEntry|PdDivider} entry
 * @returns {HTMLElement}
 */
function buildRow(entry) {
  if ('divider' in entry) {
    const div = document.createElement('div');
    div.className = 'pd-divider-row';
    div.textContent = `── ${formatTime(entry.t)} 设备断开 ──`;
    return div;
  }

  const row = document.createElement('div');
  row.className = 'pd-row';
  row.tabIndex = 0;

  const roleClass = entry.role === 'SRC' ? 'pd-role-src' : entry.role === 'SNK' ? 'pd-role-snk' : 'pd-role-cbl';
  row.innerHTML = [
    `<span class="pd-time">${formatTime(entry.t)}</span>`,
    `<span class="pd-badge pd-sop">${escapeHtml(entry.sop)}</span>`,
    entry.role ? `<span class="pd-badge ${roleClass}">${entry.role}</span>` : '<span class="pd-badge-gap"></span>',
    `<span class="pd-type">${escapeHtml(entry.type)}</span>`,
    `<span class="pd-summary">${escapeHtml(entry.summary)}</span>`,
  ].join('');

  /** @type {HTMLElement|null} */
  let detail = null;
  const toggle = () => {
    if (!detail) {
      detail = document.createElement('div');
      detail.className = 'pd-detail';
      detail.appendChild(buildTree(entry.meta));
      row.after(detail);
    } else {
      detail.hidden = !detail.hidden;
    }
    row.classList.toggle('expanded', detail !== null && !detail.hidden);
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return row;
}

/**
 * 递归构建字段树（首次展开时才调用）。
 * @param {PdMeta} meta
 * @returns {HTMLElement}
 */
function buildTree(meta) {
  const children = childrenOf(meta);
  if (children.length === 0) {
    const leaf = document.createElement('div');
    leaf.className = 'pd-leaf';
    const value = meta.value === null ? '' : String(meta.value);
    const bits = meta.bit_loc ? ` [${meta.bit_loc[0]}:${meta.bit_loc[1]}]` : '';
    leaf.innerHTML =
      `<span class="pd-leaf-field">${escapeHtml(meta.field)}</span>` +
      `<span class="pd-leaf-value">${escapeHtml(value)}</span>` +
      `<span class="pd-leaf-raw">${escapeHtml(meta.raw)}${bits}</span>`;
    return leaf;
  }

  const node = document.createElement('details');
  node.className = 'pd-node';
  node.open = true;
  const summary = document.createElement('summary');
  const quick = meta.quick_pdo ?? meta.quick_rdo;
  summary.textContent = quick ? `${meta.field} — ${quick}` : meta.field;
  node.appendChild(summary);
  for (const child of children) node.appendChild(buildTree(child));
  return node;
}

// ─── 状态显示 ────────────────────────────────────────────────────────────────

function updateEmptyState() {
  const list = els.list();
  const empty = els.empty();
  const hasRows = (list?.children.length ?? 0) > 0;
  if (list) list.hidden = !hasRows;
  if (empty) empty.hidden = hasRows;
}

function updateCounter() {
  const counter = els.counter();
  if (!counter) return;
  const parts = [`${ring.length} 条`];
  if (ring.dropped > 0) parts.push(`丢弃 ${ring.dropped}`);
  if (paused && bufferedWhilePaused > 0) parts.push(`已缓冲 ${bufferedWhilePaused}`);
  counter.textContent = parts.join(' / ');
}

/** @param {number} t */
function formatTime(t) {
  const d = new Date(t);
  const pad = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ─── 视图钩子 ────────────────────────────────────────────────────────────────

/** 首次打开 PD 视图：绑定控制条。 */
export function initPdView() {
  if (initialized) return;
  initialized = true;

  const pauseBtn = els.pauseBtn();
  const clearBtn = els.clearBtn();
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.innerHTML = paused
        ? '<i class="codicon codicon-debug-start"></i>继续'
        : '<i class="codicon codicon-debug-pause"></i>暂停';
      if (!paused) {
        bufferedWhilePaused = 0;
        rebuildAll();
      } else {
        updateCounter();
      }
    });
  }
  if (clearBtn) {
    clearBtn.disabled = false;
    clearBtn.addEventListener('click', () => {
      ring.clear();
      bufferedWhilePaused = 0;
      rebuildAll();
    });
  }

  /** @type {ReturnType<typeof setTimeout>|null} */
  let filterTimer = null;
  els.filter()?.addEventListener('input', () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTimer = null;
      rebuildAll();
    }, 150);
  });
  els.hideGoodCrc()?.addEventListener('change', () => rebuildAll());
  const followRecording = els.followRecording();
  if (followRecording) {
    followRecording.checked = state.settings.pdFollowRecording;
    followRecording.addEventListener('change', () => {
      state.settings.pdFollowRecording = followRecording.checked;
      debouncedSaveSettings();
    });
  }
  // 打开自动滚动时立即跳到底部
  els.autoscroll()?.addEventListener('change', (e) => {
    const list = els.list();
    if (/** @type {HTMLInputElement} */ (e.target).checked && list) list.scrollTop = list.scrollHeight;
  });
}

/** 每次切到 PD 视图：补齐隐藏期间收到的报文。 */
export function syncPdView() {
  rebuildAll();
}
