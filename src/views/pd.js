// @ts-check
/**
 * @file PD 协议分析视图 — pd-data 事件的接收、环形缓冲与批量渲染。
 *
 * pd-data 在后端不节流（每个 0xFE 报文即时发射），因此：
 * - 监听在 app.js 启动时就注册（插拔瞬间的握手报文最有价值，不等用户打开 Tab）；
 * - 环形缓冲封顶 2000 条，溢出覆盖最旧并计数；
 * - DOM 追加走 rAF 批处理 + DocumentFragment；视图隐藏时完全跳过 DOM 工作，
 *   重新显示时整体重建（syncPdView）。
 * - 布局为左列表 + 右详情：点击行选中，字段树只在右栏渲染一份（选中时构建）。
 */

import {
  buildPdCaptureFile,
  childrenOf,
  createRing,
  matchesFilter,
  parsePdCaptureFile,
  summarize,
} from '../pd-model.js';
import { debouncedSaveSettings } from '../settings.js';
import { state } from '../state.js';
import { syncPdCaptureUI } from '../ui/controlbar.js';
import { ask } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';

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
/** 右栏详情当前展示的条目（按对象引用与环形缓冲比对，重建后据此恢复选中行）。 */
/** @type {PdEntry|null} */
let selectedEntry = null;
/** @type {HTMLElement|null} */
let selectedRow = null;

// ─── 摘取 DOM ────────────────────────────────────────────────────────────────

const els = {
  /** @returns {HTMLElement|null} */
  list: () => document.getElementById('pd-list'),
  empty: () => document.getElementById('pd-empty'),
  counter: () => document.getElementById('pd-counter'),
  view: () => document.getElementById('view-pd'),
  pauseBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-pause')),
  clearBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-clear')),
  exportBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-export')),
  importBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-import')),
  filter: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-filter')),
  hideGoodCrc: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-hide-goodcrc')),
  autoscroll: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-autoscroll')),
  followRecording: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-follow-recording')),
  detailBody: () => document.getElementById('pd-detail-body'),
  detailEmpty: () => document.getElementById('pd-detail-empty'),
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

/**
 * 当前 PD 采集状态（供命令栏镜像与测试断言）。
 * - paused：手动暂停（报文仍进缓冲，仅停止渲染）
 * - followSuspended：跟随记录启用且未在记录（报文在 ingest 处直接丢弃）
 * - capturing：既未手动暂停也未被跟随挂起
 */
export function getPdCaptureState() {
  const followSuspended = followRecordingEnabled() && !state.isRecording;
  return { paused, followSuspended, capturing: !paused && !followSuspended };
}

// 记录状态 / 跟随设置变化时同步暂停按钮与计数器。
// data.js / settings.js 通过 document 自定义事件广播，避免向既有的
// pd.js → settings.js → data.js import 链再添加反向边。
document.addEventListener?.('witrn:recording-changed', () => {
  syncPdCaptureUI(getPdCaptureState());
  updateCounter();
});

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
    while (list.children.length > RING_CAP) {
      const first = list.children[0];
      if (first === selectedRow) clearSelection();
      first.remove();
    }
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
  /** @type {HTMLElement|null} */
  let nextSelectedRow = null;
  for (const entry of ring.toArray()) {
    if (!matchesFilter(entry, filterText, hideGoodCrc)) continue;
    const row = buildRow(entry);
    if (selectedEntry !== null && entry === selectedEntry) nextSelectedRow = row;
    fragment.appendChild(row);
  }
  list.replaceChildren(fragment);
  // 选中条目仍在列表中则恢复高亮（右栏详情内容不变，无需重渲染）；
  // 已被裁剪或过滤掉则连同右栏一起清空。
  if (nextSelectedRow) {
    selectedRow = nextSelectedRow;
    nextSelectedRow.classList.add('selected');
  } else if (selectedEntry !== null) {
    clearSelection();
  }
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

  row.addEventListener('click', () => selectRow(row, entry));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRow(row, entry);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const forward = e.key === 'ArrowDown';
      let target = forward ? row.nextElementSibling : row.previousElementSibling;
      // 跳过设备断开分隔行
      while (target && !target.classList.contains('pd-row')) {
        target = forward ? target.nextElementSibling : target.previousElementSibling;
      }
      if (target instanceof HTMLElement) {
        target.focus();
        target.click();
      }
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

// ─── 选中与右栏详情 ──────────────────────────────────────────────────────────

/**
 * 选中一行并在右栏渲染其字段树。
 * @param {HTMLElement} row @param {PdEntry} entry
 */
function selectRow(row, entry) {
  if (selectedRow === row) return;
  selectedRow?.classList.remove('selected');
  selectedRow = row;
  selectedEntry = entry;
  row.classList.add('selected');
  renderDetail(entry);
}

/** @param {PdEntry} entry */
function renderDetail(entry) {
  const body = els.detailBody();
  if (!body) return;
  body.replaceChildren(buildTree(entry.meta));
  body.hidden = false;
  const empty = els.detailEmpty();
  if (empty) empty.hidden = true;
}

/** 清除选中（选中行被裁剪 / 清空 / 被过滤掉时），右栏回到空态。 */
function clearSelection() {
  selectedRow?.classList.remove('selected');
  selectedRow = null;
  selectedEntry = null;
  const body = els.detailBody();
  if (body) {
    body.hidden = true;
    body.replaceChildren();
  }
  const empty = els.detailEmpty();
  if (empty) empty.hidden = false;
}

// ─── 导入 / 导出 ─────────────────────────────────────────────────────────────

// Tauri 对话框在运行时授予所选路径的 fs scope（见 csv.js 顶部说明）。
// dialog/fs 必须在处理器内懒解构：本模块被 node --test 导入，
// 测试 stub 的 __TAURI__ 只有 core.invoke，顶层解构会让整个测试套件崩溃。

/** 导出当前缓冲的全部报文为 JSON 捕获文件。 */
async function exportPdCapture() {
  if (ring.length === 0) {
    toast.warning('没有可导出的报文');
    return;
  }
  const { save } = window.__TAURI__.dialog;
  const { writeTextFile } = window.__TAURI__.fs;
  try {
    const path = await save({
      filters: [{ name: 'PD Capture', extensions: ['json'] }],
      defaultPath: `witrn_pd_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    });
    if (!path) return;
    // 紧凑序列化：2000 条完整解码树可达数 MB，缩进会再翻倍
    await writeTextFile(path, JSON.stringify(buildPdCaptureFile(ring.toArray())));
    toast.success(`已导出 ${ring.length} 条报文`);
  } catch (e) {
    console.error(e);
    toast.error(`导出失败: ${e}`);
  }
}

/** 从 JSON 捕获文件导入报文（替换当前缓冲）。 */
async function importPdCapture() {
  const { open } = window.__TAURI__.dialog;
  const { readTextFile } = window.__TAURI__.fs;
  try {
    if (ring.length > 0) {
      const confirmed = await ask(`导入将替换当前已捕获的 ${ring.length} 条报文，确定继续吗？`, {
        title: '确认导入',
        kind: 'warning',
      });
      if (!confirmed) return;
    }
    const selected = await open({ multiple: false, filters: [{ name: 'PD Capture', extensions: ['json'] }] });
    if (!selected) return;

    const content = await readTextFile(/** @type {string} */ (selected));
    const result = parsePdCaptureFile(JSON.parse(content));
    if (!result.ok) {
      toast.error(`导入失败: ${result.error}`);
      return;
    }

    ring.clear();
    for (const entry of result.entries) ring.push(entry);
    bufferedWhilePaused = 0;
    clearSelection();
    rebuildAll();
    const droppedNote = ring.dropped > 0 ? `（超出缓冲上限，丢弃最早 ${ring.dropped} 条）` : '';
    toast.success(`成功导入 ${ring.length} 条报文${droppedNote}`);
  } catch (e) {
    console.error(e);
    toast.error(`导入失败: ${/** @type {Error} */ (e).message}`);
  }
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
  const capture = getPdCaptureState();
  if (!capture.paused && capture.followSuspended) parts.push('跟随记录等待中');
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
      const capture = getPdCaptureState();
      // 跟随记录挂起时按钮显示「等待记录」：点击只解释原因，不产生隐藏的状态覆盖
      if (capture.followSuspended && !capture.paused) {
        toast.info('跟随记录已启用，开始记录后自动继续采集');
        return;
      }
      paused = !paused;
      if (!paused) {
        bufferedWhilePaused = 0;
        rebuildAll();
      } else {
        updateCounter();
      }
      syncPdCaptureUI(getPdCaptureState());
    });
  }
  if (clearBtn) {
    clearBtn.disabled = false;
    clearBtn.addEventListener('click', () => {
      ring.clear();
      bufferedWhilePaused = 0;
      clearSelection();
      rebuildAll();
    });
  }

  const exportBtn = els.exportBtn();
  if (exportBtn) {
    exportBtn.disabled = false;
    exportBtn.addEventListener('click', () => void exportPdCapture());
  }
  const importBtn = els.importBtn();
  if (importBtn) {
    importBtn.disabled = false;
    importBtn.addEventListener('click', () => void importPdCapture());
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
      syncPdCaptureUI(getPdCaptureState());
      updateCounter();
    });
  }
  // 打开自动滚动时立即跳到底部
  els.autoscroll()?.addEventListener('change', (e) => {
    const list = els.list();
    if (/** @type {HTMLInputElement} */ (e.target).checked && list) list.scrollTop = list.scrollHeight;
  });

  // 懒初始化前按钮不可交互，此处补齐当前状态（跟随挂起 / 手动暂停可能早于首次打开发生）
  syncPdCaptureUI(getPdCaptureState());
}

/** 每次切到 PD 视图：补齐隐藏期间收到的报文。 */
export function syncPdView() {
  rebuildAll();
}
