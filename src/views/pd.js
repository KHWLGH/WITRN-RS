// @ts-check
/**
 * @file PD 协议分析视图 — pd-data 接收、可增长日志、虚拟列表。
 *
 * pd-data 在后端不节流（每个 0xFE 报文即时发射），因此：
 * - 监听在 app.js 启动时就注册（插拔瞬间的握手报文最有价值，不等用户打开 Tab）；
 * - 日志可增长，不丢最旧；渲染只挂视口附近的行；
 * - 视图隐藏时完全跳过 DOM 工作，重新显示时重建过滤索引并同步窗口。
 * - 布局为上表 + 下详情：点击行选中，详情按 hex 字 / Header 表 / 对象表渲染。
 */

import {
  buildPdCaptureFile,
  buildRowOffsets,
  directionClass,
  displayType,
  filterIndices,
  formatBusVI,
  formatDirectionDisplay,
  formatElapsed,
  headerFields,
  hexWordsForEntry,
  isDivider,
  matchesFilter,
  msgTypeClass,
  nextMessageIndex,
  normalizePdPayload,
  noteUsesTwoLines,
  objectTables,
  PD_ROW_HEIGHT,
  PD_SOFT_CAP,
  parsePdCaptureFile,
  rowHeightOf,
  sessionOrigin,
  VI_SAMPLE_TITLE,
  visibleRangeByOffsets,
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

/** 过滤行顶边前缀和，长度 = filtered.length + 1。 */
/** @type {number[]} */
let rowOffsets = [0];
let noteColWidth = 0;
let monoAdvance = 0;

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
  tableHead: () => document.getElementById('pd-table-head'),
  split: () => document.getElementById('pd-split'),
  splitter: () => document.getElementById('pd-splitter'),
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
    appendRowOffset(entry);
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
      appendRowOffset(divider);
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

  refreshRowMetrics();
  if (rowOffsets.length !== filtered.length + 1) rebuildRowOffsets();
  const total = rowOffsets[rowOffsets.length - 1] ?? 0;

  if (followTail && autoscrollEnabled()) {
    list.scrollTop = total;
  }

  const { start, end } = visibleRangeByOffsets(rowOffsets, list.scrollTop, list.clientHeight);
  listSpacer.style.height = `${total}px`;
  listWindow.style.transform = `translateY(${rowOffsets[start] ?? 0}px)`;

  const origin = sessionOrigin(log);
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const logIndex = filtered[i];
    const entry = log[logIndex];
    if (!entry) continue;
    fragment.appendChild(buildRow(entry, logIndex, i + 1, origin));
  }
  listWindow.replaceChildren(fragment);

  updateEmptyState();
  updateCounter();
  const afterWidth = measureNoteColWidth();
  if (afterWidth > 0 && Math.abs(afterWidth - noteColWidth) > 0.5) {
    noteColWidth = afterWidth;
    rebuildRowOffsets();
    scheduleWindowSync(followTail);
  }
}

function rebuildFilterAndWindow() {
  filtered = filterIndices(log, currentFilterText(), currentHideGoodCrc());
  rebuildRowOffsets();
  if (selectedIndex !== null) {
    const still = filtered.includes(selectedIndex);
    if (!still) clearSelection();
  }
  syncWindow(autoscrollEnabled());
}

function measureNoteColWidth() {
  const note = els.tableHead()?.querySelector('.pd-col-note');
  const width = note?.getBoundingClientRect().width ?? 0;
  return width > 1 ? width : 0;
}

function measureMonoAdvance() {
  const probe = document.createElement('span');
  probe.className = 'pd-note-probe';
  probe.textContent = '0000000000';
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width > 0 ? width : 7;
}

function refreshRowMetrics() {
  const nextWidth = measureNoteColWidth();
  if (!monoAdvance) monoAdvance = measureMonoAdvance();
  if (nextWidth > 0 && Math.abs(nextWidth - noteColWidth) > 0.5) {
    noteColWidth = nextWidth;
    rebuildRowOffsets();
  }
}

function rebuildRowOffsets() {
  rowOffsets = buildRowOffsets(log, filtered, noteColWidth, monoAdvance);
}

/** @param {PdEntry|PdDivider} entry */
function appendRowOffset(entry) {
  if (rowOffsets.length !== filtered.length) {
    rebuildRowOffsets();
    return;
  }
  rowOffsets.push(rowOffsets[rowOffsets.length - 1] + rowHeightOf(entry, noteColWidth, monoAdvance));
}

/**
 * @param {PdEntry|PdDivider} entry
 * @param {number} logIndex
 * @param {number} visibleN
 * @param {number} origin
 * @returns {HTMLElement}
 */
function buildRow(entry, logIndex, visibleN, origin) {
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
  if (noteUsesTwoLines(msg.summary, noteColWidth, monoAdvance)) row.classList.add('pd-row-wrap');
  const vi = formatBusVI(msg.vbus, msg.ibus);

  row.append(
    cell('pd-col-n', String(visibleN)),
    cell('pd-col-time', formatElapsed(msg.t, origin), formatTime(msg.t)),
    cell('pd-col-sop', msg.sop),
    cell(`pd-col-msg ${msgTypeClass(msg.type)}`, displayType(msg.type)),
    cell('pd-col-id', msg.id ?? ''),
    dirCell(msg.direction ?? ''),
    cell('pd-col-obj', msg.obj ?? ''),
    cell('pd-col-rev', msg.rev ?? ''),
    cell('pd-col-vi', vi, vi ? VI_SAMPLE_TITLE : undefined),
    cell('pd-col-note', msg.summary, msg.summary),
  );

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

/**
 * @param {string} className
 * @param {string} text
 * @param {string} [title]
 */
function cell(className, text, title) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

/** @param {string} direction */
function dirCell(direction) {
  const span = document.createElement('span');
  const tone = directionClass(direction);
  span.className = tone ? `pd-col-dir ${tone}` : 'pd-col-dir';
  span.textContent = direction ? formatDirectionDisplay(direction) : '';
  if (direction) span.title = direction;
  return span;
}

/** @param {1|-1} dir */
function moveSelection(dir) {
  const from = selectedIndex === null ? (dir > 0 ? -1 : filtered.length) : filtered.indexOf(selectedIndex);
  const next = nextMessageIndex(log, filtered, from, dir);
  if (next < 0) return;
  const pos = filtered.indexOf(next);
  const list = els.list();
  if (list && pos >= 0) {
    const rowTop = rowOffsets[pos] ?? pos * PD_ROW_HEIGHT;
    const rowBot = rowOffsets[pos + 1] ?? rowTop + PD_ROW_HEIGHT;
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
    toast.warning('这条报文没有可显示的解码结果');
    return;
  }
  cacheMeta(logIndex, meta);
  const body = els.detailBody();
  if (!body) return;
  entry.meta = meta;
  body.replaceChildren(buildDetail(entry, meta));
  body.hidden = false;
  const empty = els.detailEmpty();
  if (empty) empty.hidden = true;
}

/**
 * @param {PdEntry} entry
 * @param {PdMeta} meta
 */
function buildDetail(entry, meta) {
  const wrap = document.createElement('div');
  wrap.className = 'pd-detail-stack';

  const vi = formatBusVI(entry.vbus, entry.ibus);
  if (vi) {
    const sample = document.createElement('div');
    sample.className = 'pd-detail-vi';
    sample.title = VI_SAMPLE_TITLE;
    sample.textContent = `V/I  ${vi}`;
    wrap.appendChild(sample);
  }

  const words = hexWordsForEntry(entry);
  if (words.length) wrap.appendChild(buildHexStrip(entry.sop, words));

  const header = headerFields(meta);
  if (header.length) wrap.appendChild(buildKvTable(header, 'pd-header-table'));

  for (const obj of objectTables(meta)) {
    if (obj.fields.length === 0 && !obj.chip && !obj.hex) continue;
    const block = document.createElement('div');
    block.className = 'pd-object-block';
    const title = document.createElement('div');
    title.className = 'pd-object-title';
    const name = document.createElement('span');
    name.textContent = obj.title;
    title.appendChild(name);
    if (obj.chip) {
      const chip = document.createElement('span');
      chip.className = 'pd-object-chip';
      chip.textContent = obj.chip;
      title.appendChild(chip);
    }
    if (obj.hex) {
      const hex = document.createElement('span');
      hex.className = 'pd-object-hex';
      hex.textContent = obj.hex;
      title.appendChild(hex);
    }
    block.appendChild(title);
    if (obj.fields.length) block.appendChild(buildKvTable(obj.fields, 'pd-object-table'));
    wrap.appendChild(block);
  }

  return wrap;
}

/**
 * @param {string} sop
 * @param {{ label: string, hex: string }[]} words
 */
function buildHexStrip(sop, words) {
  const table = document.createElement('table');
  table.className = 'pd-hex-strip';
  const head = document.createElement('tr');
  const body = document.createElement('tr');
  const sopTh = document.createElement('th');
  sopTh.textContent = 'SOP*';
  const sopTd = document.createElement('td');
  sopTd.textContent = sop || '—';
  head.appendChild(sopTh);
  body.appendChild(sopTd);
  for (const word of words) {
    const th = document.createElement('th');
    th.textContent = word.label;
    const td = document.createElement('td');
    td.textContent = word.hex;
    head.appendChild(th);
    body.appendChild(td);
  }
  table.append(head, body);
  return table;
}

/**
 * @param {{ label: string, value: string, className?: string }[]} fields
 * @param {string} extraClass
 */
function buildKvTable(fields, extraClass) {
  const table = document.createElement('table');
  table.className = `pd-kv-table ${extraClass}`;
  const head = document.createElement('tr');
  const body = document.createElement('tr');
  for (const field of fields) {
    const th = document.createElement('th');
    th.textContent = field.label;
    const td = document.createElement('td');
    td.textContent = field.value;
    if (field.className) td.className = field.className;
    head.appendChild(th);
    body.appendChild(td);
  }
  table.append(head, body);
  return table;
}

/** @param {number} index @param {PdMeta} meta */
function cacheMeta(index, meta) {
  metaCache.set(index, meta);
  if (metaCache.size > 8) {
    const first = metaCache.keys().next().value;
    if (first !== undefined) metaCache.delete(first);
  }
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
  rowOffsets = [0];
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
          return { t: e.t, divider: false, bytes: e.bytes ?? [], vbus: e.vbus, ibus: e.ibus };
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
  const head = els.tableHead();
  const hasRows = filtered.length > 0;
  if (list) list.hidden = !hasRows;
  if (head) head.hidden = !hasRows;
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

// ─── 视图钩子 ────────────────────────────────────────────────────────────────

function initSplitter() {
  const split = els.split();
  const handle = els.splitter();
  if (!split || !handle) return;

  /** @param {number} listRatio */
  const apply = (listRatio) => {
    const clamped = Math.min(0.8, Math.max(0.22, listRatio));
    split.style.setProperty('--pd-list-basis', `${(clamped * 100).toFixed(1)}%`);
    split.style.setProperty('--pd-detail-basis', `${((1 - clamped) * 100).toFixed(1)}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  };

  /** @type {number|null} */
  let pointer = null;
  handle.addEventListener('pointerdown', (e) => {
    pointer = e.pointerId;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (pointer === null) return;
    const rect = split.getBoundingClientRect();
    if (rect.height <= 0) return;
    apply((e.clientY - rect.top) / rect.height);
  });
  handle.addEventListener('pointerup', () => {
    pointer = null;
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const current = Number.parseFloat(getComputedStyle(split).getPropertyValue('--pd-list-basis')) / 100;
    const basis = Number.isFinite(current) ? current : 0.56;
    apply(basis + (e.key === 'ArrowUp' ? -0.04 : 0.04));
  });
}

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
  initSplitter();

  els.autoscroll()?.addEventListener('change', (e) => {
    const listEl = els.list();
    if (/** @type {HTMLInputElement} */ (e.target).checked && listEl) {
      listEl.scrollTop = rowOffsets[rowOffsets.length - 1] ?? 0;
      scheduleWindowSync(false);
    }
  });

  void document.fonts?.ready?.then(() => {
    monoAdvance = 0;
    scheduleWindowSync(false);
  });

  syncPdUi();
}

/** 每次切到 PD 视图：补齐隐藏期间收到的报文。 */
export function syncPdView() {
  rebuildFilterAndWindow();
}
