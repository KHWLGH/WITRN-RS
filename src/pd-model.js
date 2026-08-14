// @ts-check
/**
 * @file PD 报文纯逻辑 — 摘要提取、环形缓冲、过滤。无 DOM / Tauri 依赖，可被 node --test 直接测试。
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
/** @typedef {{ t: number, sop: string, type: string, role: string, summary: string, meta: PdMeta }} PdEntry */
/** @typedef {{ t: number, divider: true }} PdDivider */

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
 * 报文是否通过当前过滤条件。
 * @param {PdEntry|PdDivider} entry
 * @param {string} filterText - 消息类型子串（不区分大小写）；空串不过滤
 * @param {boolean} hideGoodCrc
 * @returns {boolean}
 */
export function matchesFilter(entry, filterText, hideGoodCrc) {
  if ('divider' in entry) return true;
  if (hideGoodCrc && entry.type === 'GoodCRC') return false;
  const needle = filterText.trim().toLowerCase();
  if (needle === '') return true;
  return entry.type.toLowerCase().includes(needle);
}

/**
 * 定长环形缓冲：满后覆盖最旧项并累计丢弃数。
 * @template T
 * @param {number} cap
 * @returns {{ push: (item: T) => void, toArray: () => T[], clear: () => void, readonly length: number, readonly dropped: number }}
 */
export function createRing(cap) {
  /** @type {T[]} */
  let items = [];
  let start = 0;
  let dropped = 0;

  return {
    /** @param {T} item */
    push(item) {
      if (items.length < cap) {
        items.push(item);
      } else {
        items[start] = item;
        start = (start + 1) % cap;
        dropped++;
      }
    },
    toArray() {
      return start === 0 ? items.slice() : items.slice(start).concat(items.slice(0, start));
    },
    clear() {
      items = [];
      start = 0;
      dropped = 0;
    },
    get length() {
      return items.length;
    },
    get dropped() {
      return dropped;
    },
  };
}

// ─── 捕获文件（导入 / 导出） ─────────────────────────────────────────────────

/** @typedef {{ app: string, kind: 'pd-capture', version: 1, exportedAt: string, entries: (PdEntry|PdDivider)[] }} PdCaptureFile */

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
 * 构造导出文件对象（entries 直接引用传入数组，序列化前不做拷贝）。
 * @param {(PdEntry|PdDivider)[]} entries
 * @returns {PdCaptureFile}
 */
export function buildPdCaptureFile(entries) {
  return { app: 'WITRN-RS', kind: 'pd-capture', version: 1, exportedAt: new Date().toISOString(), entries };
}

/**
 * 解析并校验捕获文件（传入已 JSON.parse 的对象）。
 * 合法条目会用 summarize(meta) 重算摘要字段：防手改文件破坏列表显示，
 * 同时保证导入后的过滤 / 展示行为与实时捕获完全一致（无损往返）。
 * @param {unknown} raw
 * @returns {{ ok: true, entries: (PdEntry|PdDivider)[] } | { ok: false, error: string }}
 */
export function parsePdCaptureFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '不是有效的捕获文件' };
  const file = /** @type {Record<string, unknown>} */ (raw);
  if (file.kind !== 'pd-capture') return { ok: false, error: '文件类型不匹配（缺少 pd-capture 标记）' };
  if (file.version !== 1) return { ok: false, error: `不支持的文件版本: ${String(file.version)}` };
  if (!Array.isArray(file.entries)) return { ok: false, error: '缺少报文数组' };

  /** @type {(PdEntry|PdDivider)[]} */
  const entries = [];
  for (const item of file.entries) {
    if (!item || typeof item !== 'object') return { ok: false, error: '存在非法报文条目' };
    const t = /** @type {Record<string, unknown>} */ (item).t;
    if (!Number.isFinite(t)) return { ok: false, error: '存在缺少时间戳的条目' };
    if (/** @type {Record<string, unknown>} */ (item).divider === true) {
      entries.push({ t: /** @type {number} */ (t), divider: true });
      continue;
    }
    const meta = /** @type {Record<string, unknown>} */ (item).meta;
    if (!isValidMeta(meta)) return { ok: false, error: '存在无法解析的报文结构' };
    entries.push({ t: /** @type {number} */ (t), ...summarize(meta), meta });
  }
  return { ok: true, entries };
}
