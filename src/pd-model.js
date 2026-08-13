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
