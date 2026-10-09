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

import { runCooperativeSlices } from '../cooperative.js';
import { errorText, t } from '../i18n.js';
import { exportPdFile } from '../pd-export.js';
import {
  buildRowOffsets,
  createPdProjection,
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
/** First message timestamp is invariant across append; scrolling never scans the log. */
/** @type {number|null} */
let originTime = null;
/** 过滤后的日志下标。 */
/** @type {number[]} */
let filtered = [];

let paused = false;
let bufferedWhilePaused = 0;
let renderScheduled = false;
let followTailPending = false;
let initialized = false;
let softCapWarned = false;
/** 已入库报文的最大 seq；用于去重和 `pd_log_after` 补洞。 */
let lastIngestedSeq = -1;
/** 与后端 `PdLog.generation` 对齐；导入 / 清空后用来丢掉过期的实时事件。 */
let acceptedGen = /** @type {number|null} */ (null);
/** 导入或清空进行中，暂不接受实时事件。 */
let ingestSuspended = false;

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
/** @type {{cancelled: boolean}|null} */
let projectionWork = null;

function cancelProjection() {
  if (projectionWork) projectionWork.cancelled = true;
  projectionWork = null;
  els.list()?.setAttribute?.('aria-busy', 'false');
}

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
  layoutBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-layout')),
  layoutIcon: () => document.getElementById('pd-layout-icon'),
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
 * @param {PdEntry|PdDivider} entry
 */
function rememberSeq(entry) {
  if (!isDivider(entry) && Number.isFinite(entry.seq) && /** @type {number} */ (entry.seq) > lastIngestedSeq) {
    lastIngestedSeq = /** @type {number} */ (entry.seq);
  }
}

/**
 * @param {unknown} payload
 * @param {boolean} [live=true] 实时事件才走跟随记录门控；补洞 / 导入回放关掉。
 * @returns {boolean} 是否写入了一条日志
 */
function ingestOne(payload, live = true) {
  if (live && ingestSuspended) return false;
  if (live && followRecordingEnabled() && !state.isRecording) return false;
  const entry = normalizePdPayload(payload);
  if (!entry) return false;
  if (!isDivider(entry)) {
    const gen = Number.isFinite(entry.gen) ? /** @type {number} */ (entry.gen) : null;
    if (gen !== null) {
      if (acceptedGen === -1) return false;
      if (acceptedGen !== null && gen !== acceptedGen) return false;
      acceptedGen = gen;
    }
    const seq = entry.seq;
    if (seq !== undefined && Number.isFinite(seq) && seq <= lastIngestedSeq) return false;
  }
  rememberSeq(entry);
  log.push(entry);
  if (originTime === null && !isDivider(entry)) originTime = entry.t;
  if (log.length === PD_SOFT_CAP && !softCapWarned) {
    softCapWarned = true;
    toast.warning(() => t('pdSoftCap', { count: PD_SOFT_CAP }));
  }
  if (paused) {
    bufferedWhilePaused++;
    return true;
  }
  if (viewHidden()) return true;
  if (projectionWork) return true;
  if (matchesFilter(entry, currentFilterText(), currentHideGoodCrc())) {
    filtered.push(log.length - 1);
    appendRowOffset(entry);
  }
  return true;
}

/**
 * app.js 的 pd-data / 单条路径入口（测试与导入回放也走这里）。
 * @param {unknown} payload
 */
export function ingestPdData(payload) {
  if (!ingestOne(payload)) return;
  if (paused) {
    updateCounter();
    return;
  }
  if (viewHidden()) return;
  scheduleWindowSync(true);
}

/**
 * 后端按帧合并后的 `pd-data-batch`：先全部入库，再只排一次窗口同步。
 * @param {unknown} payloads
 * @param {boolean} [live=true]
 */
export function ingestPdBatch(payloads, live = true) {
  if (!Array.isArray(payloads) || payloads.length === 0) return;
  let added = 0;
  for (const payload of payloads) {
    if (ingestOne(payload, live)) added += 1;
  }
  if (!added) return;
  if (paused) {
    updateCounter();
    return;
  }
  if (viewHidden()) return;
  scheduleWindowSync(true);
}

/**
 * 切回 PD 视图时按 seq 向后端补齐可能漏掉的报文。
 */
async function fillPdGap() {
  const afterSeq = lastIngestedSeq >= 0 ? lastIngestedSeq : null;
  try {
    const extra = await invokeCmd('pd_log_after', { afterSeq });
    if (Array.isArray(extra) && extra.length) ingestPdBatch(extra, false);
  } catch (e) {
    console.error(e);
  }
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
  // 点开始后后端门已开、本地 ingest 刚放行：把等待期间入库的握手补进来。
  if (state.isRecording) void fillPdGap();
});

/** 设备断开时插入分隔行，区分两次会话。 */
export function markPdDisconnect() {
  if (log.length === 0) return;
  const last = log[log.length - 1];
  if (last && isDivider(last)) return;
  /** @type {PdDivider} */
  const divider = { t: Date.now(), divider: true };
  log.push(divider);
  if (!paused && !viewHidden() && !projectionWork) {
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
  // Publish the scroll extent first: setting scrollTop against the old, shorter
  // filter would clamp it and leave follow mode in the middle of the new list.
  listSpacer.style.height = `${total}px`;

  if (followTail && autoscrollEnabled()) {
    list.scrollTop = total;
  }

  const { start, end } = visibleRangeByOffsets(rowOffsets, list.scrollTop, list.clientHeight);
  listWindow.style.transform = `translateY(${rowOffsets[start] ?? 0}px)`;

  const origin = originTime ?? 0;
  patchWindow(start, end, origin);

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
  cancelProjection();
  if (log.length > 4096) {
    const width = measureNoteColWidth();
    if (width > 0) noteColWidth = width;
    if (!monoAdvance) monoAdvance = measureMonoAdvance();
    const next = createPdProjection(log, currentFilterText(), currentHideGoodCrc(), noteColWidth, monoAdvance);
    const work = { cancelled: false };
    projectionWork = work;
    els.list()?.setAttribute?.('aria-busy', 'true');
    void runCooperativeSlices(() => next.step(), { isCancelled: () => work.cancelled || viewHidden() })
      .then((complete) => {
        if (projectionWork !== work) return;
        projectionWork = null;
        els.list()?.setAttribute?.('aria-busy', 'false');
        if (!complete) return;
        filtered = next.indices;
        rowOffsets = next.offsets;
        if (selectedIndex !== null && !filtered.includes(selectedIndex)) clearSelection();
        syncWindow(autoscrollEnabled());
      })
      .catch((error) => {
        if (projectionWork === work) cancelProjection();
        console.error(error);
        toast.error(() => t('pdListUpdateFailed'));
      });
    return;
  }
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
  const oldAdvance = monoAdvance;
  if (!monoAdvance) monoAdvance = measureMonoAdvance();
  if ((nextWidth > 0 && Math.abs(nextWidth - noteColWidth) > 0.5) || oldAdvance !== monoAdvance) {
    if (nextWidth > 0) noteColWidth = nextWidth;
    rebuildRowOffsets();
  }
}

function rebuildRowOffsets() {
  if (log.length > 4096) {
    rebuildFilterAndWindow();
    return;
  }
  rowOffsets = buildRowOffsets(log, filtered, noteColWidth, monoAdvance);
}

/**
 * 视口行就地补丁：同类行改文字，类型变了才换节点。
 * @param {number} start
 * @param {number} end
 * @param {number} origin
 */
function patchWindow(start, end, origin) {
  if (!listWindow) return;
  let node = listWindow.firstChild;
  for (let i = start; i < end; i++) {
    const logIndex = filtered[i];
    const entry = log[logIndex];
    if (!entry) continue;
    const wantDivider = isDivider(entry);
    const reusable =
      node instanceof HTMLElement &&
      (wantDivider ? node.classList.contains('pd-divider-row') : node.classList.contains('pd-row'));
    if (reusable && node instanceof HTMLElement) {
      if (wantDivider) {
        const text = `── ${formatTime(entry.t)} ${t('pdDisconnected')} ──`;
        if (node.textContent !== text) node.textContent = text;
      } else {
        updateMessageRow(node, /** @type {PdEntry} */ (entry), logIndex, i + 1, origin);
      }
      node = node.nextSibling;
      continue;
    }
    const next = buildRow(entry, logIndex, i + 1, origin);
    if (node instanceof HTMLElement) {
      node.replaceWith(next);
      node = next.nextSibling;
    } else {
      listWindow.appendChild(next);
    }
  }
  while (node) {
    const dead = node;
    node = node.nextSibling;
    dead.remove();
  }
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
    div.textContent = `── ${formatTime(entry.t)} ${t('pdDisconnected')} ──`;
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
    cell('pd-col-vi', vi, vi ? t('pdBusHint') : undefined),
    cell('pd-col-note', msg.summary, msg.summary),
  );
  return row;
}

/**
 * @param {HTMLElement} row
 * @param {PdEntry} msg
 * @param {number} logIndex
 * @param {number} visibleN
 * @param {number} origin
 */
function updateMessageRow(row, msg, logIndex, visibleN, origin) {
  row.dataset.index = String(logIndex);
  row.classList.toggle('selected', selectedIndex === logIndex);
  row.classList.toggle('pd-row-wrap', noteUsesTwoLines(msg.summary, noteColWidth, monoAdvance));
  const vi = formatBusVI(msg.vbus, msg.ibus);
  const kids = row.children;
  setCellText(kids[0], String(visibleN));
  setCellText(kids[1], formatElapsed(msg.t, origin), formatTime(msg.t));
  setCellText(kids[2], msg.sop);
  if (kids[3]) {
    kids[3].className = `pd-col-msg ${msgTypeClass(msg.type)}`;
    setCellText(kids[3], displayType(msg.type));
  }
  setCellText(kids[4], msg.id ?? '');
  if (kids[5] instanceof HTMLElement) {
    const tone = directionClass(msg.direction ?? '');
    kids[5].className = tone ? `pd-col-dir ${tone}` : 'pd-col-dir';
    kids[5].textContent = msg.direction ? formatDirectionDisplay(msg.direction) : '';
    kids[5].title = msg.direction || '';
  }
  setCellText(kids[6], msg.obj ?? '');
  setCellText(kids[7], msg.rev ?? '');
  setCellText(kids[8], vi, vi ? t('pdBusHint') : '');
  setCellText(kids[9], msg.summary, msg.summary);
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

/**
 * @param {Element|undefined} el
 * @param {string} text
 * @param {string} [title]
 */
function setCellText(el, text, title) {
  if (!(el instanceof HTMLElement)) return;
  if (el.textContent !== text) el.textContent = text;
  if (title !== undefined && el.title !== title) el.title = title;
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
      toast.error(() => t('decodeFailed', { detail: errorText(e) }));
      return;
    }
  }
  if (selectedIndex !== logIndex) return;
  if (!meta) {
    toast.warning(() => t('noDecodeResult'));
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
    sample.title = t('pdBusHint');
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
  cancelProjection();
  log.length = 0;
  originTime = null;
  filtered = [];
  rowOffsets = [0];
  bufferedWhilePaused = 0;
  softCapWarned = false;
  lastIngestedSeq = -1;
  acceptedGen = -1;
  metaCache.clear();
  clearSelection();
  void invokeCmd('pd_log_clear')
    .then((gen) => {
      acceptedGen = typeof gen === 'number' && Number.isFinite(gen) ? gen : null;
    })
    .catch((e) => {
      console.error(e);
      acceptedGen = null;
      toast.error(() => t('clearPdLogFailed', { detail: errorText(e) }));
    });
  rebuildFilterAndWindow();
}

/**
 * 「清空」动作：确认 → 清空 → 跟随记录开启时级联清空监控数据。
 */
export async function requestPdClear() {
  const follow = followRecordingEnabled();
  if (log.length === 0 && !follow) return;

  const confirmed = await ask(
    () =>
      (log.length > 0 ? t('clearPdPromptCount', { count: log.length }) : t('clearPdPromptEmpty')) +
      (follow ? `\n${t('clearPdLinkedPrompt')}` : ''),
    { title: () => t('clear'), kind: follow ? 'error' : 'warning' },
  );
  if (!confirmed) return;

  clearPdEntries();
  if (follow) state.__clearMonitorData?.();
}

// ─── 导入 / 导出 ─────────────────────────────────────────────────────────────

let exportPending = false;
async function exportPdCapture() {
  if (exportPending) return;
  if (log.length === 0) {
    toast.warning(() => t('noMessagesToExport'));
    return;
  }
  exportPending = true;
  try {
    const count = await exportPdFile(() => log);
    if (count !== null) toast.success(() => t('exportPdCount', { count }));
  } catch (e) {
    console.error(e);
    toast.error(() => t('csvExportFailed', { detail: errorText(e) }));
  } finally {
    exportPending = false;
  }
}

async function importPdCapture() {
  const { open } = window.__TAURI__.dialog;
  const { readTextFile } = window.__TAURI__.fs;
  try {
    if (log.length > 0) {
      const confirmed = await ask(() => t('importPdReplace', { count: log.length }), {
        title: () => t('import'),
        kind: 'warning',
      });
      if (!confirmed) return;
    }
    const selected = await open({
      title: t('pdImportTitle'),
      multiple: false,
      filters: [{ name: t('pdFile'), extensions: ['json'] }],
    });
    if (!selected) return;

    const content = await readTextFile(/** @type {string} */ (selected));
    const result = parsePdCaptureFile(JSON.parse(content));
    if (!result.ok) {
      toast.error(() => t('csvImportFailed', { detail: errorText(result.description) }));
      return;
    }

    ingestSuspended = true;
    await invokeCmd('set_pd_capture_enabled', { enabled: false });

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
      if (!Array.isArray(loaded)) {
        toast.error(() => t('pdBackendReplaceFailed'));
        return;
      }
      nextEntries = [];
      for (const ev of loaded) {
        const entry = normalizePdPayload(ev);
        if (entry) nextEntries.push(entry);
      }
    } else {
      const gen = await invokeCmd('pd_log_clear');
      if (typeof gen === 'number' && Number.isFinite(gen)) {
        acceptedGen = gen;
      } else {
        toast.error(() => t('pdBackendClearFailed'));
        return;
      }
    }

    cancelProjection();
    log.length = 0;
    originTime = null;
    filtered = [];
    bufferedWhilePaused = 0;
    softCapWarned = false;
    lastIngestedSeq = -1;
    if (needBackend) acceptedGen = null;
    metaCache.clear();
    clearSelection();
    for (const entry of nextEntries) {
      log.push(entry);
      if (originTime === null && !isDivider(entry)) originTime = entry.t;
      rememberSeq(entry);
      if (!isDivider(entry) && Number.isFinite(entry.gen)) acceptedGen = /** @type {number} */ (entry.gen);
    }

    rebuildFilterAndWindow();
    const count = log.length;
    toast.success(() => t('importPdCount', { count }));
  } catch (e) {
    console.error(e);
    toast.error(() => t('csvImportFailed', { detail: errorText(e) }));
  } finally {
    ingestSuspended = false;
    syncBackendCaptureFlag();
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
  const parts = [t('pdCounter', { count: log.length })];
  if (paused && bufferedWhilePaused > 0) parts.push(t('pdBuffered', { count: bufferedWhilePaused }));
  const capture = getPdCaptureState();
  if (!capture.paused && capture.followSuspended) parts.push(t('pdFollowWaiting'));
  counter.textContent = parts.join(' / ');
}

/** @param {number} t */
function formatTime(t) {
  const d = new Date(t);
  const pad = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ─── 视图钩子 ────────────────────────────────────────────────────────────────

const PD_SIDE_MIN_WIDTH = 1400;

/**
 * 按偏好与窗口宽度应用 PD 分栏方向。宽屏（≥1400px）且偏好开启时左右分栏。
 */
export function applyPdSplitLayout() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const split = els.split();
  const handle = els.splitter();
  const btn = els.layoutBtn();
  const icon = els.layoutIcon();
  const preferSide = state.settings.pdSplitSide === true;
  const side = preferSide && window.innerWidth >= PD_SIDE_MIN_WIDTH;
  split?.classList.toggle('pd-split-side', side);
  if (handle) {
    handle.style.cursor = side ? 'col-resize' : 'row-resize';
    handle.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
    handle.setAttribute('aria-label', side ? t('pdAdjustWidth') : t('pdAdjustHeight'));
  }
  if (btn) {
    btn.setAttribute('aria-pressed', String(preferSide));
    btn.title = preferSide ? t('pdSplitBack') : t('pdSplitSide');
    btn.setAttribute('aria-label', btn.title);
  }
  if (icon) {
    icon.classList.toggle('fi-split-side', !preferSide);
    icon.classList.toggle('fi-split', preferSide);
  }
}

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
  /** @param {PointerEvent} e */
  const endDrag = (e) => {
    if (pointer === null || e.pointerId !== pointer) return;
    pointer = null;
  };
  handle.addEventListener('pointerdown', (e) => {
    pointer = e.pointerId;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    // 只认 pointer !== null 不够：捕获被抢走后它仍非空，裸移动鼠标会继续改写分栏。
    if (pointer === null || !handle.hasPointerCapture(e.pointerId)) return;
    const rect = split.getBoundingClientRect();
    const side = split.classList.contains('pd-split-side');
    if (side) {
      if (rect.width <= 0) return;
      apply((e.clientX - rect.left) / rect.width);
    } else {
      if (rect.height <= 0) return;
      apply((e.clientY - rect.top) / rect.height);
    }
  });
  // 捕获被其他元素抢走时浏览器只发 lostpointercapture，漏掉它 pointer 就永不归零。
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('keydown', (e) => {
    const side = split.classList.contains('pd-split-side');
    const shrink = side ? 'ArrowLeft' : 'ArrowUp';
    const grow = side ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== shrink && e.key !== grow) return;
    e.preventDefault();
    const current = Number.parseFloat(getComputedStyle(split).getPropertyValue('--pd-list-basis')) / 100;
    const basis = Number.isFinite(current) ? current : 0.56;
    apply(basis + (e.key === shrink ? -0.04 : 0.04));
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
    list.addEventListener('click', (e) => {
      const hit = e.target instanceof Element ? e.target.closest('.pd-row') : null;
      if (!(hit instanceof HTMLElement) || !list.contains(hit)) return;
      const idx = Number(hit.dataset.index);
      if (Number.isInteger(idx)) void selectIndex(idx, hit);
    });
    list.addEventListener('keydown', (e) => {
      const row = e.target instanceof HTMLElement && e.target.classList.contains('pd-row') ? e.target : null;
      if (!row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const idx = Number(row.dataset.index);
        if (Number.isInteger(idx)) void selectIndex(idx, row);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
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
          toast.warning(() => t('pleaseConnect'));
          return;
        }
        state.__toggleRecording?.();
        return;
      }

      paused = !paused;
      if (paused) cancelProjection();
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

  els.filter()?.addEventListener('input', () => rebuildFilterAndWindow());
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
  const layoutBtn = els.layoutBtn();
  if (layoutBtn) {
    layoutBtn.addEventListener('click', () => {
      state.settings.pdSplitSide = !state.settings.pdSplitSide;
      applyPdSplitLayout();
      debouncedSaveSettings();
    });
  }
  initSplitter();
  applyPdSplitLayout();

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

/** 每次切到 PD 视图：先补 seq 缺口，再重建过滤窗口。 */
export function syncPdView() {
  refreshPdLanguage();
  void fillPdGap().then(() => rebuildFilterAndWindow());
}

/** Refresh state-derived text without changing the capture gate, filters or selection. */
export function refreshPdLanguage() {
  syncPdCaptureUI(getPdCaptureState(), {
    followEnabled: followRecordingEnabled(),
    connected: state.isConnected,
    recording: state.isRecording,
  });
  updateCounter();
  applyPdSplitLayout();
  for (const element of document.querySelectorAll('.pd-detail-vi')) element.setAttribute('title', t('pdBusHint'));
  if (!viewHidden()) syncWindow(false);
}
