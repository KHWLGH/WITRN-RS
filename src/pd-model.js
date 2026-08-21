// @ts-check
/**
 * @file PD 报文纯逻辑 — 摘要提取、过滤、视口切片、捕获文件。无 DOM / Tauri 依赖。
 *
 * 载荷是 usbpd-parser::Metadata 的 serde 序列化树：
 * `{ raw, bit_loc: [hi,lo]|null, field, value, quick_pdo?, quick_rdo?, full_raw? }`，
 * value 为 null | boolean | number | string | 子节点数组。
 * 根节点子项含 "SOP*"（值为 "SOP"/"SOP'"…）与 "Message Header"
 * （其子项含 "Message Type" 和 "Port Power Role"（SOP）/ "Cable Plug"（SOP'/''））；
 * 数据消息还有 "Data Objects" / "Data Block"，其子节点带 quick_pdo / quick_rdo 速览。
 */

/** @typedef {null|boolean|number|string|PdMeta[]} PdValue */
/** @typedef {{ raw: string, bit_loc: [number, number]|null, field: string, value: PdValue, quick_pdo?: string, quick_rdo?: string, full_raw?: string }} PdMeta */
/**
 * @typedef {{ t: number, sop: string, type: string, role: string, summary: string, meta?: PdMeta, bytes?: number[], seq?: number }} PdEntry
 */
/** @typedef {{ t: number, divider: true }} PdDivider */

/** 虚拟列表行高（与 `.pd-row` / `.pd-divider-row` 的 CSS 一致）。 */
export const PD_ROW_HEIGHT = 24;
/** 视口上下各多渲染的行数。 */
export const PD_OVERSCAN = 12;
/** 超过该条数 toast 警告，但默认继续存储。 */
export const PD_SOFT_CAP = 500_000;

/**
 * 子节点数组（叶子节点返回空数组）。
 * @param {PdMeta} meta
 * @returns {PdMeta[]}
 */
export function childrenOf(meta) {
  return Array.isArray(meta.value) ? meta.value : [];
}

/**
 * 按字段名找直接子节点。
 * @param {PdMeta|null|undefined} meta
 * @param {string} field
 * @returns {PdMeta|null}
 */
export function findChild(meta, field) {
  if (!meta) return null;
  for (const child of childrenOf(meta)) {
    if (child.field === field) return child;
  }
  return null;
}

/**
 * 提取列表行需要的摘要信息。
 * @param {PdMeta} meta
 * @returns {{ sop: string, type: string, role: string, summary: string }}
 */
export function summarize(meta) {
  const sopValue = findChild(meta, 'SOP*')?.value;
  const sop = typeof sopValue === 'string' ? sopValue : '?';

  const header = findChild(meta, 'Message Header') ?? findChild(meta, 'Extended Message Header') ?? null;
  const typeValue = findChild(header, 'Message Type')?.value;
  const type = typeof typeValue === 'string' ? typeValue : '未知';

  let role = '';
  const powerRole = findChild(header, 'Port Power Role')?.value;
  if (powerRole === 'Source') role = 'SRC';
  else if (powerRole === 'Sink') role = 'SNK';
  else if (findChild(header, 'Cable Plug')) role = 'CBL';

  const objects = findChild(meta, 'Data Objects') ?? findChild(meta, 'Data Block');
  /** @type {string[]} */
  const quicks = [];
  for (const child of childrenOf(
    /** @type {PdMeta} */ (objects ?? { raw: '', bit_loc: null, field: '', value: null }),
  )) {
    const quick = child.quick_pdo ?? child.quick_rdo;
    if (quick) quicks.push(quick);
  }
  return { sop, type, role, summary: quicks.join('  ') };
}

/**
 * @param {PdEntry|PdDivider} entry
 * @returns {entry is PdDivider}
 */
export function isDivider(entry) {
  return 'divider' in entry && entry.divider === true;
}

/**
 * 报文是否通过当前过滤条件。
 * @param {PdEntry|PdDivider} entry
 * @param {string} filterText - 消息类型子串（不区分大小写）；空串不过滤
 * @param {boolean} hideGoodCrc
 * @returns {boolean}
 */
export function matchesFilter(entry, filterText, hideGoodCrc) {
  if (isDivider(entry)) return true;
  const msg = /** @type {PdEntry} */ (entry);
  if (hideGoodCrc && msg.type === 'GoodCRC') return false;
  const needle = filterText.trim().toLowerCase();
  if (needle === '') return true;
  return msg.type.toLowerCase().includes(needle);
}

/**
 * 过滤结果为日志下标数组，供虚拟列表切片。
 * @param {(PdEntry|PdDivider)[]} entries
 * @param {string} filterText
 * @param {boolean} hideGoodCrc
 * @returns {number[]}
 */
export function filterIndices(entries, filterText, hideGoodCrc) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    if (matchesFilter(entries[i], filterText, hideGoodCrc)) out.push(i);
  }
  return out;
}

/**
 * 虚拟列表窗口 [start, end)（filter 下标）。
 * @param {number} filterCount
 * @param {number} scrollTop
 * @param {number} viewHeight
 * @param {number} [rowHeight=PD_ROW_HEIGHT]
 * @param {number} [overscan=PD_OVERSCAN]
 * @returns {{ start: number, end: number }}
 */
export function visibleRange(filterCount, scrollTop, viewHeight, rowHeight = PD_ROW_HEIGHT, overscan = PD_OVERSCAN) {
  if (filterCount <= 0) return { start: 0, end: 0 };
  const rh = rowHeight > 0 ? rowHeight : PD_ROW_HEIGHT;
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const vh = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : rh;
  const start = Math.max(0, Math.floor(top / rh) - overscan);
  const end = Math.min(filterCount, Math.ceil((top + vh) / rh) + overscan);
  return { start, end: Math.max(start, end) };
}

/**
 * 从当前过滤下标走向下一个报文行（跳过分隔行）。
 * @param {(PdEntry|PdDivider)[]} entries
 * @param {number[]} indices
 * @param {number} fromFilterPos
 * @param {1|-1} dir
 * @returns {number} 目标日志下标；没有则返回 -1
 */
export function nextMessageIndex(entries, indices, fromFilterPos, dir) {
  for (let p = fromFilterPos + dir; p >= 0 && p < indices.length; p += dir) {
    const logIndex = indices[p];
    const entry = entries[logIndex];
    if (entry && !isDivider(entry)) return logIndex;
  }
  return -1;
}

// ─── 捕获文件（导入 / 导出） ─────────────────────────────────────────────────

/** @typedef {{ app: string, kind: 'pd-capture', version: 1|2, exportedAt: string, entries: unknown[] }} PdCaptureFile */

/** meta 递归校验的深度上限（真实 PD 解码树不超过 5 层，防御构造的深嵌套文件）。 */
const META_MAX_DEPTH = 32;

/**
 * 校验一棵 PdMeta 树的结构（与 serde 序列化的 usbpd-parser::Metadata 对齐）。
 * @param {unknown} meta
 * @param {number} [depth=0]
 * @returns {meta is PdMeta}
 */
function isValidMeta(meta, depth = 0) {
  if (depth > META_MAX_DEPTH) return false;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const m = /** @type {Record<string, unknown>} */ (meta);
  if (typeof m.raw !== 'string' || typeof m.field !== 'string') return false;
  const loc = m.bit_loc;
  if (loc != null && !(Array.isArray(loc) && loc.length === 2 && loc.every((n) => Number.isFinite(n)))) return false;
  for (const key of ['quick_pdo', 'quick_rdo', 'full_raw']) {
    if (m[key] !== undefined && typeof m[key] !== 'string') return false;
  }
  const value = m.value;
  if (Array.isArray(value)) return value.every((child) => isValidMeta(child, depth + 1));
  return value === null || ['boolean', 'number', 'string'].includes(typeof value);
}

/**
 * @param {unknown} raw
 * @returns {number[]|undefined}
 */
function normalizeBytes(raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  /** @type {number[]} */
  const out = [];
  for (const n of raw) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return undefined;
    out.push(n);
  }
  return out;
}

/**
 * 构造导出文件。默认 v2：有原始帧就只带 bytes，否则带解码树以便 v1 数据往返。
 * @param {(PdEntry|PdDivider)[]} entries
 * @returns {PdCaptureFile}
 */
export function buildPdCaptureFile(entries) {
  const packed = entries.map((e) => {
    if (isDivider(e)) return { t: e.t, divider: true };
    const msg = /** @type {PdEntry} */ (e);
    /** @type {Record<string, unknown>} */
    const out = { t: msg.t, sop: msg.sop, type: msg.type, role: msg.role, summary: msg.summary };
    if (msg.bytes && msg.bytes.length > 0) out.bytes = msg.bytes;
    else if (msg.meta) out.meta = msg.meta;
    return out;
  });
  return { app: 'WITRN-RS', kind: 'pd-capture', version: 2, exportedAt: new Date().toISOString(), entries: packed };
}

/**
 * 解析并校验捕获文件（传入已 JSON.parse 的对象）。
 * v1：整树，用 summarize(meta) 重算摘要。
 * v2：紧凑日志（bytes 和/或 meta）。
 * @param {unknown} raw
 * @returns {{ ok: true, entries: (PdEntry|PdDivider)[] } | { ok: false, error: string }}
 */
export function parsePdCaptureFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '不是有效的捕获文件' };
  const file = /** @type {Record<string, unknown>} */ (raw);
  if (file.kind !== 'pd-capture') return { ok: false, error: '文件类型不匹配（缺少 pd-capture 标记）' };
  if (file.version !== 1 && file.version !== 2) {
    return { ok: false, error: `不支持的文件版本: ${String(file.version)}` };
  }
  if (!Array.isArray(file.entries)) return { ok: false, error: '缺少报文数组' };

  /** @type {(PdEntry|PdDivider)[]} */
  const entries = [];
  for (const item of file.entries) {
    if (!item || typeof item !== 'object') return { ok: false, error: '存在非法报文条目' };
    const rec = /** @type {Record<string, unknown>} */ (item);
    const t = rec.t;
    if (!Number.isFinite(t)) return { ok: false, error: '存在缺少时间戳的条目' };
    if (rec.divider === true) {
      entries.push({ t: /** @type {number} */ (t), divider: true });
      continue;
    }
    if (rec.meta !== undefined) {
      if (!isValidMeta(rec.meta)) return { ok: false, error: '存在无法解析的报文结构' };
      const bytes = rec.bytes === undefined ? undefined : normalizeBytes(rec.bytes);
      if (rec.bytes !== undefined && bytes === undefined) return { ok: false, error: '存在无法解析的原始帧' };
      /** @type {PdEntry} */
      const entry = { t: /** @type {number} */ (t), ...summarize(rec.meta), meta: rec.meta };
      if (bytes) entry.bytes = bytes;
      entries.push(entry);
      continue;
    }
    if (file.version === 1) return { ok: false, error: '存在无法解析的报文结构' };
    if (typeof rec.sop !== 'string' || typeof rec.type !== 'string') {
      return { ok: false, error: '存在缺少摘要的报文条目' };
    }
    const bytes = rec.bytes === undefined ? undefined : normalizeBytes(rec.bytes);
    if (rec.bytes !== undefined && bytes === undefined) return { ok: false, error: '存在无法解析的原始帧' };
    /** @type {PdEntry} */
    const entry = {
      t: /** @type {number} */ (t),
      sop: rec.sop,
      type: rec.type,
      role: typeof rec.role === 'string' ? rec.role : '',
      summary: typeof rec.summary === 'string' ? rec.summary : '',
    };
    if (bytes) entry.bytes = bytes;
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * 把实时事件 / 旧式解码树归一成日志条目。无法识别时返回 null。
 * @param {unknown} payload
 * @returns {PdEntry|PdDivider|null}
 */
export function normalizePdPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (payload);
  const t = Number.isFinite(rec.t) ? /** @type {number} */ (rec.t) : Date.now();
  if (rec.divider === true) return { t, divider: true };

  if (rec.meta && typeof rec.meta === 'object' && !Array.isArray(rec.meta)) {
    const meta = /** @type {PdMeta} */ (rec.meta);
    /** @type {PdEntry} */
    const entry = { t, ...summarize(meta), meta };
    const bytes = normalizeBytes(rec.bytes);
    if (bytes) entry.bytes = bytes;
    if (Number.isFinite(rec.seq)) entry.seq = /** @type {number} */ (rec.seq);
    return entry;
  }

  // 旧 IPC：整棵 Metadata 树
  if (typeof rec.field === 'string' && 'value' in rec && typeof rec.raw === 'string') {
    const meta = /** @type {PdMeta} */ (payload);
    return { t, ...summarize(meta), meta };
  }

  if (typeof rec.type === 'string') {
    /** @type {PdEntry} */
    const entry = {
      t,
      sop: typeof rec.sop === 'string' ? rec.sop : '?',
      type: rec.type,
      role: typeof rec.role === 'string' ? rec.role : '',
      summary: typeof rec.summary === 'string' ? rec.summary : '',
    };
    const bytes = normalizeBytes(rec.bytes);
    if (bytes) entry.bytes = bytes;
    if (Number.isFinite(rec.seq)) entry.seq = /** @type {number} */ (rec.seq);
    return entry;
  }
  return null;
}
