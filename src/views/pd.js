// @ts-check
/**
 * @file PD 协议分析视图 — pd-data 接收、可增长日志、虚拟列表。
 *
 * pd-data 在后端不节流（每个 0xFE 报文即时发射），因此：
 * - 监听在 app.js 启动时就注册（插拔瞬间的握手报文最有价值，不等用户打开 Tab）；
 * - 日志可增长，不丢最旧；渲染只挂视口附近的行；
 * - 视图隐藏时完全跳过 DOM 工作，重新显示时重建过滤索引并同步窗口。
 * - 布局为左列表 + 右详情：点击行选中，字段树只在右栏渲染一份。
 */

import {
  buildPdCaptureFile,
  childrenOf,
  filterIndices,
  isDivider,
  matchesFilter,
  nextMessageIndex,
  normalizePdPayload,
  PD_ROW_HEIGHT,
  PD_SOFT_CAP,
  parsePdCaptureFile,
  visibleRange,
} from '../pd-model.js';
import { debouncedSaveSettings } from '../settings.js';
import { state } from '../state.js';
import { syncPdCaptureUI } from '../ui/controlbar.js';
import { ask } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';

/** @typedef {import('../pd-model.js').PdMeta} PdMeta */
/** @typedef {import('../pd-model.js').PdEntry} PdEntry */
/** @typedef {import('../pd-model.js').PdDivider} PdDivider */

/** @type {(PdEntry|PdDivider)[]} */
const log = [];
/** 过滤后的日志下标。 */
/** @type {number[]} */
let filtered = [];

let paused = false;
let bufferedWhilePaused = 0;
let renderScheduled = false;
let followTailPending = false;
let initialized = false;
let softCapWarned = false;

/** 当前选中的日志下标。 */
/** @type {number|null} */
let selectedIndex = null;

/** @type {Map<number, PdMeta>} */
const metaCache = new Map();

/** @type {HTMLElement|null} */
let listSpacer = null;
/** @type {HTMLElement|null} */
let listWindow = null;

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

/** @param {string} cmd @param {Record<string, unknown>} [args] */
function invokeCmd(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return Promise.resolve(null);
  return invoke(cmd, args);
}

function pdCaptureEnabled() {
  return !followRecordingEnabled() || state.isRecording;
}

function syncBackendCaptureFlag() {
  void invokeCmd('set_pd_capture_enabled', { enabled: pdCaptureEnabled() });
}

// ─── 摄入 ────────────────────────────────────────────────────────────────────

/**
 * app.js 的 pd-data 监听器入口。
 * @param {unknown} payload
 */
export function ingestPdData(payload) {
  if (followRecordingEnabled() && !state.isRecording) return;
  const entry = normalizePdPayload(payload);
  if (!entry) return;
  log.push(entry);
  if (log.length === PD_SOFT_CAP && !softCapWarned) {
    softCapWarned = true;
    toast.warning(`PD 报文已达 ${PD_SOFT_CAP} 条，继续存储可能占用较多内存`);
  }
  if (paused) {
    bufferedWhilePaused++;
    updateCounter();
    return;
  }
  if (viewHidden()) return;
  if (matchesFilter(entry, currentFilterText(), currentHideGoodCrc())) {
    filtered.push(log.length - 1);
  }
  scheduleWindowSync(true);
}

/** 当前 PD 日志中的条目数（用于诊断与测试）。 */
export function getPdBufferLength() {
  return log.length;
}

/**
 * 当前 PD 采集状态（供命令栏镜像与测试断言）。
 * - paused：手动暂停（报文仍进缓冲，仅停止渲染）—— 仅在跟随记录关闭时可达
 * - followSuspended：跟随记录启用且未在记录（报文在 ingest 处直接丢弃）
 * - capturing：既未手动暂停也未被跟随挂起
 */
export function getPdCaptureState() {
  const followSuspended = followRecordingEnabled() && !state.isRecording;
  return { paused, followSuspended, capturing: !paused && !followSuspended };
}

/**
 * 把当前状态同步到 PD 命令栏：采集按钮外观 + 计数器。
 */
function syncPdUi() {
  const follow = followRecordingEnabled();
  syncPdCaptureUI(getPdCaptureState(), {
    followEnabled: follow,
    connected: state.isConnected,
    recording: state.isRecording,
  });
  const button = els.pauseBtn();
  if (button && initialized) button.disabled = follow && !state.isConnected;
  updateCounter();
  syncBackendCaptureFlag();
}

document.addEventListener?.('witrn:monitor-changed', () => {
  syncPdUi();
});

/** 设备断开时插入分隔行，区分两次会话。 */
export function markPdDisconnect() {
  if (log.length === 0) return;
  const last = log[log.length - 1];
  if (last && isDivider(last)) return;
  /** @type {PdDivider} */
  const divider = { t: Date.now(), divider: true };
  log.push(divider);
  if (!paused && !viewHidden()) {
    if (matchesFilter(divider, currentFilterText(), currentHideGoodCrc())) {
      filtered.push(log.length - 1);
    }
    scheduleWindowSync(true);
  }
}

// ─── 虚拟列表 ────────────────────────────────────────────────────────────────

function ensureListStructure() {
  const list = els.list();
  if (!list) return null;
  if (!listSpacer || !listWindow || listSpacer.parentElement !== list) {
    list.replaceChildren();
    const spacer = document.createElement('div');
    spacer.className = 'pd-list-spacer';
    const win = document.createElement('div');
    win.className = 'pd-list-window';
    spacer.appendChild(win);
    list.appendChild(spacer);
    listSpacer = spacer;
    listWindow = win;
  }
  return list;
}

/** @param {boolean} [followTail=false] */
function scheduleWindowSync(followTail = false) {
  if (followTail) followTailPending = true;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    const follow = followTailPending;
    followTailPending = false;
    syncWindow(follow);
  });
}

/**
 * @param {boolean} [followTail]
 */
function syncWindow(followTail = false) {
  const list = ensureListStructure();
  if (!list || !listSpacer || !listWindow) {
    updateCounter();
    return;
  }

  if (followTail && autoscrollEnabled()) {
    list.scrollTop = filtered.length * PD_ROW_HEIGHT;
  }

  const { start, end } = visibleRange(filtered.length, list.scrollTop, list.clientHeight);
  listSpacer.style.height = `${filtered.length * PD_ROW_HEIGHT}px`;
  listWindow.style.transform = `translateY(${start * PD_ROW_HEIGHT}px)`;

  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const logIndex = filtered[i];
    const entry = log[logIndex];
    if (!entry) continue;
    fragment.appendChild(buildRow(entry, logIndex));
  }
  listWindow.replaceChildren(fragment);

  updateEmptyState();
  updateCounter();
}

function rebuildFilterAndWindow() {
  filtered = filterIndices(log, currentFilterText(), currentHideGoodCrc());
  if (selectedIndex !== null) {
    const still = filtered.includes(selectedIndex);
    if (!still) clearSelection();
  }
  syncWindow(autoscrollEnabled());
}

/**
 * @param {PdEntry|PdDivider} entry
 * @param {number} logIndex
 * @returns {HTMLElement}
 */
function buildRow(entry, logIndex) {
  if (isDivider(entry)) {
    const div = document.createElement('div');
    div.className = 'pd-divider-row';
    div.textContent = `── ${formatTime(entry.t)} 设备断开 ──`;
    return div;
  }

  const msg = /** @type {PdEntry} */ (entry);
  const row = document.createElement('div');
  row.className = 'pd-row';
  row.tabIndex = 0;
  row.dataset.index = String(logIndex);
  if (selectedIndex === logIndex) row.classList.add('selected');

  const roleClass = msg.role === 'SRC' ? 'pd-role-src' : msg.role === 'SNK' ? 'pd-role-snk' : 'pd-role-cbl';
  row.innerHTML = [
    `<span class="pd-time">${formatTime(msg.t)}</span>`,
    `<span class="pd-badge pd-sop">${escapeHtml(msg.sop)}</span>`,
    msg.role ? `<span class="pd-badge ${roleClass}">${msg.role}</span>` : '<span class="pd-badge-gap"></span>',
    `<span class="pd-type">${escapeHtml(msg.type)}</span>`,
    `<span class="pd-summary">${escapeHtml(msg.summary)}</span>`,
  ].join('');

  row.addEventListener('click', () => void selectIndex(logIndex, row));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void selectIndex(logIndex, row);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });
  return row;
}

/** @param {1|-1} dir */
function moveSelection(dir) {
  const from = selectedIndex === null ? (dir > 0 ? -1 : filtered.length) : filtered.indexOf(selectedIndex);
  const next = nextMessageIndex(log, filtered, from, dir);
  if (next < 0) return;
  const pos = filtered.indexOf(next);
  const list = els.list();
  if (list && pos >= 0) {
    const rowTop = pos * PD_ROW_HEIGHT;
    const rowBot = rowTop + PD_ROW_HEIGHT;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowBot > list.scrollTop + list.clientHeight) list.scrollTop = rowBot - list.clientHeight;
  }
  syncWindow();
  const row = listWindow?.querySelector(`[data-index="${next}"]`);
  void selectIndex(next, row instanceof HTMLElement ? row : null);
  if (row instanceof HTMLElement) row.focus();
}

/**
 * @param {number} logIndex
 * @param {HTMLElement|null} [row]
 */
async function selectIndex(logIndex, row = null) {
  const entry = log[logIndex];
  if (!entry || isDivider(entry)) return;
  if (selectedIndex === logIndex && row?.classList.contains('selected')) return;
  selectedIndex = logIndex;
  if (listWindow) {
    for (const el of listWindow.querySelectorAll('.pd-row.selected')) el.classList.remove('selected');
  }
  row?.classList.add('selected');
  await renderDetail(/** @type {PdEntry} */ (entry), logIndex);
}

/**
 * @param {PdEntry} entry
 * @param {number} logIndex
 */
async function renderDetail(entry, logIndex) {
  let meta = entry.meta ?? metaCache.get(logIndex) ?? null;
  if (!meta && Number.isFinite(entry.seq)) {
    try {
      const decoded = await invokeCmd('decode_pd_at', { index: entry.seq });
      if (decoded && typeof decoded === 'object') meta = /** @type {PdMeta} */ (decoded);
    } catch (e) {
      console.error(e);
      toast.error(`解码失败: ${e}`);
      return;
    }
  }
  if (selectedIndex !== logIndex) return;
  if (!meta) {
    toast.warning('这条报文没有可显示的解码树');
    return;
  }
  cacheMeta(logIndex, meta);
  const body = els.detailBody();
  if (!body) return;
  body.replaceChildren(buildTree(meta));
  body.hidden = false;
  const empty = els.detailEmpty();
  if (empty) empty.hidden = true;
}

/** @param {number} index @param {PdMeta} meta */
function cacheMeta(index, meta) {
  metaCache.set(index, meta);
  if (metaCache.size > 8) {
    const first = metaCache.keys().next().value;
    if (first !== undefined) metaCache.delete(first);
  }
}

/**
 * 递归构建字段树（选中时才调用）。
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

function clearSelection() {
  selectedIndex = null;
  if (listWindow) {
    for (const el of listWindow.querySelectorAll('.pd-row.selected')) el.classList.remove('selected');
  }
  const body = els.detailBody();
  if (body) {
    body.hidden = true;
    body.replaceChildren();
  }
  const empty = els.detailEmpty();
  if (empty) empty.hidden = false;
}

// ─── 清空 ────────────────────────────────────────────────────────────────────

/**
 * 纯清空：无确认、无联动。监控面板的「一键重置」在跟随记录开启时调用它，
 * 两侧各自只调用对方的无级联版本，因此不会互相递归。
 */
export function clearPdEntries() {
  log.length = 0;
  filtered = [];
  bufferedWhilePaused = 0;
  softCapWarned = false;
  metaCache.clear();
  clearSelection();
  void invokeCmd('pd_log_clear');
  rebuildFilterAndWindow();
}

/**
 * 「清空」动作：确认 → 清空 → 跟随记录开启时级联清空监控数据。
 */
export async function requestPdClear() {
  const follow = followRecordingEnabled();
  if (log.length === 0 && !follow) return;

  const head = log.length > 0 ? `确定要清空已捕获的 ${log.length} 条报文吗？` : 'PD 报文列表已是空的，确定要继续吗？';
  const linked = follow ? '\n跟随记录已开启，监控图表、统计与累计能量也会一并重置。' : '';

  const confirmed = await ask(head + linked, { title: '确认清空', kind: follow ? 'error' : 'warning' });
  if (!confirmed) return;

  clearPdEntries();
  if (follow) state.__clearMonitorData?.();
}

// ─── 导入 / 导出 ─────────────────────────────────────────────────────────────

async function exportPdCapture() {
  if (log.length === 0) {
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
    await writeTextFile(path, JSON.stringify(buildPdCaptureFile(log)));
    toast.success(`已导出 ${log.length} 条报文`);
  } catch (e) {
    console.error(e);
    toast.error(`导出失败: ${e}`);
  }
}

async function importPdCapture() {
  const { open } = window.__TAURI__.dialog;
  const { readTextFile } = window.__TAURI__.fs;
  try {
    if (log.length > 0) {
      const confirmed = await ask(`导入将替换当前已捕获的 ${log.length} 条报文，确定继续吗？`, {
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

    const needBackend = result.entries.some((e) => {
      if (isDivider(e)) return false;
      return (e.bytes?.length ?? 0) > 0;
    });

    /** @type {(typeof result.entries)} */
    let nextEntries = result.entries;
    if (needBackend) {
      const loaded = await invokeCmd('pd_log_replace', {
        entries: result.entries.map((e) => {
          if (isDivider(e)) return { t: e.t, divider: true, bytes: [] };
          return { t: e.t, divider: false, bytes: e.bytes ?? [] };
        }),
      });
      if (!Array.isArray(loaded) || loaded.length !== result.entries.length) {
        toast.error('导入失败: 后端无法替换报文日志');
        return;
      }
      nextEntries = [];
      for (const ev of loaded) {
        const entry = normalizePdPayload(ev);
        if (entry) nextEntries.push(entry);
      }
    } else {
      void invokeCmd('pd_log_clear');
    }

    log.length = 0;
    filtered = [];
    bufferedWhilePaused = 0;
    softCapWarned = false;
    metaCache.clear();
    clearSelection();
    for (const entry of nextEntries) log.push(entry);

    rebuildFilterAndWindow();
    toast.success(`成功导入 ${log.length} 条报文`);
  } catch (e) {
    console.error(e);
    toast.error(`导入失败: ${/** @type {Error} */ (e).message}`);
  }
}

// ─── 状态显示 ────────────────────────────────────────────────────────────────

function updateEmptyState() {
  const list = els.list();
  const empty = els.empty();
  const hasRows = filtered.length > 0;
  if (list) list.hidden = !hasRows;
  if (empty) empty.hidden = hasRows;
}

function updateCounter() {
  const counter = els.counter();
  if (!counter) return;
  const parts = [`${log.length} 条`];
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

  const list = els.list();
  if (list) {
    ensureListStructure();
    list.addEventListener('scroll', () => scheduleWindowSync(false), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => scheduleWindowSync(false)).observe(list);
    }
  }

  const pauseBtn = els.pauseBtn();
  const clearBtn = els.clearBtn();
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.addEventListener('click', () => {
      if (followRecordingEnabled()) {
        if (!state.isRecording && !state.isConnected) {
          toast.warning('请先连接设备');
          return;
        }
        state.__toggleRecording?.();
        return;
      }

      paused = !paused;
      if (!paused) {
        bufferedWhilePaused = 0;
        rebuildFilterAndWindow();
      }
      syncPdUi();
    });
  }
  if (clearBtn) {
    clearBtn.disabled = false;
    clearBtn.addEventListener('click', () => void requestPdClear());
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
      rebuildFilterAndWindow();
    }, 150);
  });
  els.hideGoodCrc()?.addEventListener('change', () => rebuildFilterAndWindow());
  const followRecording = els.followRecording();
  if (followRecording) {
    followRecording.checked = state.settings.pdFollowRecording;
    followRecording.addEventListener('change', () => {
      state.settings.pdFollowRecording = followRecording.checked;
      if (followRecording.checked && paused) {
        paused = false;
        bufferedWhilePaused = 0;
        rebuildFilterAndWindow();
      }
      debouncedSaveSettings();
      document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
    });
  }
  els.autoscroll()?.addEventListener('change', (e) => {
    const listEl = els.list();
    if (/** @type {HTMLInputElement} */ (e.target).checked && listEl) {
      listEl.scrollTop = filtered.length * PD_ROW_HEIGHT;
      scheduleWindowSync(false);
    }
  });

  syncPdUi();
}

/** 每次切到 PD 视图：补齐隐藏期间收到的报文。 */
export function syncPdView() {
  rebuildFilterAndWindow();
}
