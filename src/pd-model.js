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
 * @typedef {{
 *   t: number,
 *   sop: string,
 *   type: string,
 *   role: string,
 *   summary: string,
 *   id?: string,
 *   obj?: string,
 *   rev?: string,
 *   direction?: string,
 *   vbus?: number,
 *   ibus?: number,
 *   meta?: PdMeta,
 *   bytes?: number[],
 *   seq?: number,
 *   gen?: number,
 * }} PdEntry
 */
/** @typedef {{ t: number, divider: true }} PdDivider */
/** @typedef {{ label: string, hex: string }} PdHexWord */
/** @typedef {{ label: string, value: string, className?: string }} PdField */
/** @typedef {{ title: string, chip: string, hex: string, fields: PdField[], nested: boolean }} PdObjectTable

/** 单行行高（与 `.pd-row` / `.pd-divider-row` 的 CSS 一致）。 */
export const PD_ROW_HEIGHT = 24;
/** Note 折成两行时的行高（与 `.pd-row-wrap` 的 CSS 一致）。 */
export const PD_ROW_HEIGHT_WRAP = 40;
/** 电压范围里的非断行连字符，避免 `5.00-21.00V` 从中间拆开。 */
export const NOTE_NB_HYPHEN = '\u2011';
/** V/I 列说明：仪表最近一次 0xFF 采样，不是报文同时刻。 */
export const VI_SAMPLE_TITLE = '最近一次测量采样，不是报文同时刻';
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

const EMPTY_META = /** @type {PdMeta} */ ({ raw: '', bit_loc: null, field: '', value: null });

/** 列表 Msg 列的短名。未列出的类型只把下划线换成空格。 */
const TYPE_SHORT = {
  Source_Capabilities: 'Source Cap',
  Sink_Capabilities: 'Sink Cap',
  Vendor_Defined: 'Vendor Defined',
  Source_Capabilities_Extended: 'Src Cap Ext',
  Sink_Capabilities_Extended: 'Snk Cap Ext',
  EPR_Source_Capabilities: 'EPR Src Cap',
  EPR_Sink_Capabilities: 'EPR Snk Cap',
  Get_Source_Cap: 'Get Src Cap',
  Get_Sink_Cap: 'Get Snk Cap',
  Get_Source_Cap_Extended: 'Get Src Cap Ext',
  Get_Sink_Cap_Extended: 'Get Snk Cap Ext',
  Vendor_Defined_Extended: 'VDM Ext',
  Soft_Reset: 'Soft Reset',
  Hard_Reset: 'Hard Reset',
  Cable_Reset: 'Cable Reset',
  Data_Reset: 'Data Reset',
  Data_Reset_Complete: 'Data Reset Done',
  Not_Supported: 'Not Supported',
  Get_PPS_Status: 'Get PPS Status',
  Get_Source_Info: 'Get Src Info',
  EPR_Request: 'EPR Request',
  EPR_Mode: 'EPR Mode',
};

/** Header 表的短列名。 */
const HEADER_LABELS = {
  'Number of Data Objects': 'Objects',
  MessageID: 'Msg ID',
  'Port Power Role': 'Power Role',
  'Specification Revision': 'Spec Rev',
  'Port Data Role': 'Data Role',
  'Message Type': 'Msg Type',
};

/**
 * 提取列表行需要的摘要信息。
 * @param {PdMeta} meta
 * @returns {{ sop: string, type: string, role: string, summary: string, id: string, obj: string, rev: string, direction: string }}
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
  for (const child of childrenOf(objects ?? EMPTY_META)) {
    const quick = child.quick_pdo ?? child.quick_rdo;
    if (quick) quicks.push(quick);
  }

  return {
    sop,
    type,
    role,
    summary: formatNote(type, quicks, meta),
    id: leafText(findChild(header, 'MessageID')?.value),
    obj: leafText(findChild(header, 'Number of Data Objects')?.value),
    rev: specRevShort(findChild(header, 'Specification Revision')?.value),
    direction: directionOf(sop, role, header),
  };
}

/**
 * @param {string} sop
 * @param {string} role
 * @param {PdMeta|null} header
 */
export function directionOf(sop, role, header) {
  const plugSop = sop === "SOP'" || sop === "SOP''" || sop === "SOP'_DEBUG" || sop === "SOP''_DEBUG";
  if (plugSop) {
    const plug = findChild(header, 'Cable Plug')?.value;
    if (typeof plug === 'string' && plug.startsWith('Cable Plug')) return 'SRC|SNK←Plug';
    return 'SRC|SNK→Plug';
  }
  if (role === 'SRC') return 'SRC→SNK';
  if (role === 'SNK') return 'SRC←SNK';
  return '';
}

/**
 * @param {unknown} value
 */
function specRevShort(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.includes('1')) return 'V1';
  if (value.includes('2')) return 'V2';
  if (value.includes('3')) return 'V3';
  return value;
}

/**
 * @param {string} type
 * @param {string[]} quicks
 * @param {PdMeta} meta
 */
export function formatNote(type, quicks, meta) {
  if (
    type === 'Source_Capabilities' ||
    type === 'Sink_Capabilities' ||
    type === 'EPR_Source_Capabilities' ||
    type === 'EPR_Sink_Capabilities'
  ) {
    return formatCapNote(quicks);
  }
  if (type === 'Request' || type === 'EPR_Request') return formatRequestNote(quicks[0] ?? '');
  if (type === 'Vendor_Defined' || type === 'Vendor_Defined_Extended') return formatVdmNote(meta);
  return quicks.join('  ');
}

/**
 * @param {string[]} quicks
 */
export function formatCapNote(quicks) {
  const groups = {
    Fixed: /** @type {string[]} */ ([]),
    Battery: /** @type {string[]} */ ([]),
    Variable: /** @type {string[]} */ ([]),
    'SPR AVS': /** @type {string[]} */ ([]),
    'EPR AVS': /** @type {string[]} */ ([]),
    PPS: /** @type {string[]} */ ([]),
  };
  for (const q of quicks) {
    const m = /^(EF|EA|SA|EB|EV|F|B|V|P) (.+)$/.exec(q);
    if (!m) continue;
    const kind = m[1];
    const rest = m[2];
    if (kind === 'F' || kind === 'EF') groups.Fixed.push(protectNoteToken(rest.split('@')[0] ?? rest));
    else if (kind === 'P') groups.PPS.push(protectNoteToken(rest.split('@')[0] ?? rest));
    else if (kind === 'SA') groups['SPR AVS'].push(protectNoteToken(rest));
    else if (kind === 'EA') groups['EPR AVS'].push(protectNoteToken(rest.split('@')[0] ?? rest));
    else if (kind === 'V' || kind === 'EV') groups.Variable.push(protectNoteToken(rest));
    else if (kind === 'B' || kind === 'EB') groups.Battery.push(protectNoteToken(rest));
  }
  /** @type {string[]} */
  const parts = [];
  for (const label of ['Fixed', 'Battery', 'Variable', 'SPR AVS', 'EPR AVS', 'PPS']) {
    const items = groups[/** @type {keyof typeof groups} */ (label)];
    if (items.length) parts.push(`${label}: ${items.join(' ')}`);
  }
  return parts.join('  ');
}

/**
 * @param {string} quick
 */
export function formatRequestNote(quick) {
  if (!quick) return '';
  const m = /^\[(\d+)\] (EF|EA|SA|EB|EV|F|B|V|P) (.+)$/.exec(quick);
  if (!m) return quick;
  const names = {
    F: 'Fixed',
    EF: 'EPR Fixed',
    P: 'PPS',
    SA: 'SPR AVS',
    EA: 'EPR AVS',
    V: 'Variable',
    EV: 'EPR Variable',
    B: 'Battery',
    EB: 'EPR Battery',
  };
  const kind = names[/** @type {keyof typeof names} */ (m[2])] ?? m[2];
  return `Position:${m[1]} ${kind}:${protectNoteToken(m[3].replace('@', ','))}`;
}

/**
 * 挡位内部的数字范围改成非断行连字符，只允许在空格处折行。
 * @param {string} text
 */
export function protectNoteToken(text) {
  return text.replace(/(\d)-(\d)/g, `$1${NOTE_NB_HYPHEN}$2`);
}

/**
 * @param {PdMeta} meta
 */
function formatVdmNote(meta) {
  const objects = findChild(meta, 'Data Objects') ?? findChild(meta, 'Data Block');
  const header = findChild(objects, 'VDM Header');
  if (!header) return '';
  const command = findChild(header, 'Command')?.value;
  const cmdType = findChild(header, 'Command Type')?.value;
  const svid = findChild(header, 'SVID')?.value ?? findChild(header, 'VID')?.value;
  const vdmType = findChild(header, 'VDM Type')?.value;
  /** @type {string[]} */
  const parts = [];
  if (vdmType === 'Unstructured') parts.push('Unstructured');
  if (typeof svid === 'string' && svid) parts.push(svid);
  if (typeof command === 'string' && command) parts.push(command);
  else if (typeof command === 'number') parts.push(`CMD ${command}`);
  if (typeof cmdType === 'string' && cmdType) parts.push(cmdType);
  return parts.join(' ');
}

/**
 * @param {string} type
 */
export function displayType(type) {
  return TYPE_SHORT[/** @type {keyof typeof TYPE_SHORT} */ (type)] ?? type.replaceAll('_', ' ');
}

/**
 * 列表 Msg 格的着色类名。
 * @param {string} type
 */
export function msgTypeClass(type) {
  switch (type) {
    case 'GoodCRC':
      return 'pd-msg-crc';
    case 'Request':
    case 'EPR_Request':
      return 'pd-msg-request';
    case 'Accept':
      return 'pd-msg-accept';
    case 'PS_RDY':
      return 'pd-msg-psrdy';
    case 'Reject':
    case 'Wait':
    case 'Not_Supported':
      return 'pd-msg-reject';
    case 'Soft_Reset':
    case 'Hard_Reset':
    case 'Cable_Reset':
    case 'Data_Reset':
    case 'Data_Reset_Complete':
      return 'pd-msg-reset';
    case 'Vendor_Defined':
    case 'Vendor_Defined_Extended':
      return 'pd-msg-vdm';
    case 'Source_Capabilities':
    case 'Source_Capabilities_Extended':
    case 'EPR_Source_Capabilities':
      return 'pd-msg-srccap';
    case 'Sink_Capabilities':
    case 'Sink_Capabilities_Extended':
    case 'EPR_Sink_Capabilities':
      return 'pd-msg-snkcap';
    case 'DR_Swap':
    case 'PR_Swap':
    case 'VCONN_Swap':
    case 'FR_Swap':
      return 'pd-msg-swap';
    case 'Alert':
    case 'Status':
    case 'Battery_Status':
    case 'PPS_Status':
    case 'Source_Info':
    case 'Revision':
    case 'Battery_Capabilities':
      return 'pd-msg-alert';
    case 'Ping':
    case 'GotoMin':
    case 'BIST':
      return 'pd-msg-ping';
    case 'Enter_USB':
    case 'EPR_Mode':
    case 'Extended_Control':
      return 'pd-msg-mode';
    case 'Manufacturer_Info':
    case 'Security_Request':
    case 'Security_Response':
    case 'Firmware_Update_Request':
    case 'Firmware_Update_Response':
    case 'Country_Info':
    case 'Country_Codes':
      return 'pd-msg-ext';
    default:
      if (type.startsWith('Get_')) return 'pd-msg-get';
      return 'pd-msg-other';
  }
}

/**
 * 列表 Direction 格的着色类。箭头符号不改，只靠颜色区分流向。
 * @param {string} direction
 */
export function directionClass(direction) {
  if (!direction) return '';
  if (direction.includes('Plug')) return 'pd-dir-plug';
  if (direction.includes('←')) return 'pd-dir-snk';
  if (direction.includes('→')) return 'pd-dir-src';
  return '';
}

/**
 * 列表显示用：箭头略加长，存储值仍是 `SRC→SNK`。
 * @param {string} direction
 */
export function formatDirectionDisplay(direction) {
  return direction.replaceAll('→', ' ⟶ ').replaceAll('←', ' ⟵ ');
}

/**
 * Header 表 Power Role 格的着色类。
 * @param {string} value
 */
export function powerRoleClass(value) {
  if (value === 'Source') return 'pd-dir-src';
  if (value === 'Sink') return 'pd-dir-snk';
  return '';
}

/**
 * @param {number|undefined|null} vbus
 * @param {number|undefined|null} ibus
 */
export function formatBusVI(vbus, ibus) {
  if (!Number.isFinite(vbus) || !Number.isFinite(ibus)) return '';
  return `${/** @type {number} */ (vbus).toFixed(3)}V/${/** @type {number} */ (ibus).toFixed(3)}A`;
}

/**
 * 相对会话起点的经过时间，形如 `0:00:06.197`。
 * @param {number} t
 * @param {number} origin
 */
export function formatElapsed(t, origin) {
  const ms = Math.max(0, Math.round(t - origin));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

/**
 * 第一条非分隔报文的时间戳，用作 Elapsed 原点。
 * @param {(PdEntry|PdDivider)[]} entries
 */
export function sessionOrigin(entries) {
  for (const entry of entries) {
    if (!isDivider(entry)) return entry.t;
  }
  return 0;
}

/**
 * HID `0xFE` 帧去掉前导后的 PD 报文字节；已经是载荷则原样返回。
 * @param {number[]|undefined} bytes
 * @returns {number[]}
 */
export function pdWireBytes(bytes) {
  if (!bytes || bytes.length === 0) return [];
  if (bytes[0] === 0xfe && bytes.length >= 3) {
    const end = Math.min(bytes.length, Number(bytes[1]) + 2);
    return bytes.slice(3, Math.max(3, end));
  }
  return bytes.slice();
}

/**
 * @param {string} bits
 */
export function bitsToHexWord(bits) {
  if (!bits || !/^[01]+$/.test(bits)) return '';
  const n = Number.parseInt(bits, 2);
  if (!Number.isFinite(n)) return '';
  const width = Math.ceil(bits.length / 4);
  return `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;
}

/**
 * 按规格把报文字节拆成 Header + 32-bit 对象。
 * @param {number[]} wire
 * @returns {PdHexWord[]}
 */
export function hexWordsFromWire(wire) {
  /** @type {PdHexWord[]} */
  const words = [];
  if (wire.length < 2) return words;
  const header = wire[0] | (wire[1] << 8);
  words.push({ label: 'Msg Header', hex: `0x${header.toString(16).toUpperCase().padStart(4, '0')}` });
  const extended = (header & 0x8000) !== 0;
  let i = 2;
  if (extended && wire.length >= 4) {
    const ext = wire[2] | (wire[3] << 8);
    words.push({ label: 'Ext Header', hex: `0x${ext.toString(16).toUpperCase().padStart(4, '0')}` });
    i = 4;
  }
  for (let n = 0; i + 3 < wire.length; i += 4, n++) {
    const word = wire[i] | (wire[i + 1] << 8) | (wire[i + 2] << 16) | (wire[i + 3] << 24);
    words.push({
      label: `Data Object ${n}`,
      hex: `0x${(word >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
    });
  }
  if (i < wire.length) {
    let rem = 0;
    const leftover = wire.length - i;
    for (let b = 0; b < leftover; b++) rem |= wire[i + b] << (8 * b);
    words.push({
      label: 'Data',
      hex: `0x${(rem >>> 0)
        .toString(16)
        .toUpperCase()
        .padStart(leftover * 2, '0')}`,
    });
  }
  return words;
}

/**
 * 没有原始帧时，从解码树的 raw 位串拼 hex 字。
 * @param {PdMeta} meta
 * @returns {PdHexWord[]}
 */
export function hexWordsFromMeta(meta) {
  /** @type {PdHexWord[]} */
  const words = [];
  const header = findChild(meta, 'Message Header');
  const headerHex = header ? bitsToHexWord(header.raw) : '';
  if (headerHex) words.push({ label: 'Msg Header', hex: headerHex });
  const ext = findChild(meta, 'Extended Message Header');
  const extHex = ext ? bitsToHexWord(ext.raw) : '';
  if (extHex) words.push({ label: 'Ext Header', hex: extHex });
  const objects = findChild(meta, 'Data Objects') ?? findChild(meta, 'Data Block');
  let n = 0;
  for (const child of childrenOf(objects ?? EMPTY_META)) {
    const hex = bitsToHexWord(child.raw);
    if (hex) words.push({ label: child.field || `Data Object ${n}`, hex });
    n++;
  }
  return words;
}

/**
 * @param {PdEntry} entry
 * @returns {PdHexWord[]}
 */
export function hexWordsForEntry(entry) {
  const wire = pdWireBytes(entry.bytes);
  if (wire.length >= 2) return hexWordsFromWire(wire);
  return entry.meta ? hexWordsFromMeta(entry.meta) : [];
}

/**
 * @param {unknown} value
 */
export function formatLeafValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function leafText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return String(value);
  return '';
}

/**
 * @param {PdMeta} meta
 * @returns {PdField[]}
 */
export function headerFields(meta) {
  const header = findChild(meta, 'Message Header');
  if (!header) return [];
  /** @type {PdField[]} */
  const fields = [];
  for (const child of childrenOf(header)) {
    if (child.field === 'Reserved' || Array.isArray(child.value)) continue;
    const value = formatLeafValue(child.value);
    fields.push({
      label: HEADER_LABELS[/** @type {keyof typeof HEADER_LABELS} */ (child.field)] ?? child.field,
      value,
      className: child.field === 'Port Power Role' ? powerRoleClass(value) : '',
    });
  }
  return fields;
}

/**
 * @param {PdMeta} obj
 */
function objectChip(obj) {
  const supply = findChild(obj, 'Supply Type')?.value;
  const tag = typeof supply === 'string' ? supply : '';
  const quick = obj.quick_pdo ?? obj.quick_rdo ?? '';
  if (obj.quick_pdo) {
    const rest = obj.quick_pdo.replace(/^(EF|EA|SA|EB|EV|F|B|V|P) /, '').replace('@', ',');
    return tag ? `${rest} ${tag}` : rest;
  }
  if (quick && tag) return `${quick} ${tag}`;
  return quick;
}

/**
 * @param {PdMeta} meta
 * @returns {PdObjectTable[]}
 */
export function objectTables(meta) {
  const objects = findChild(meta, 'Data Objects') ?? findChild(meta, 'Data Block');
  return flattenObjectTables(childrenOf(objects ?? EMPTY_META), '');
}

/**
 * 容器出表，子容器再递归出表（替代原来的解码树）。
 * @param {PdMeta[]} objs
 * @param {string} prefix
 * @returns {PdObjectTable[]}
 */
function flattenObjectTables(objs, prefix) {
  /** @type {PdObjectTable[]} */
  const out = [];
  objs.forEach((obj, i) => {
    /** @type {PdField[]} */
    const fields = [];
    /** @type {PdMeta[]} */
    const nested = [];
    for (const child of childrenOf(obj)) {
      if (child.field === 'Reserved') continue;
      if (Array.isArray(child.value)) nested.push(child);
      else fields.push({ label: child.field, value: formatLeafValue(child.value) });
    }
    const title = prefix ? `${prefix} / ${obj.field || `Object ${i + 1}`}` : obj.field || `Object ${i + 1}`;
    const hex = bitsToHexWord(obj.raw);
    const chip = objectChip(obj);
    if (fields.length || chip || hex) {
      out.push({
        title,
        chip,
        hex,
        fields,
        nested: nested.length > 0,
      });
    }
    if (nested.length) out.push(...flattenObjectTables(nested, title));
  });
  return out;
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
  return compilePdFilter(filterText, hideGoodCrc)(entry);
}

/** Normalize the query once for a whole scan.
 * @param {string} filterText @param {boolean} hideGoodCrc
 */
export function compilePdFilter(filterText, hideGoodCrc) {
  const needle = filterText.trim().toLowerCase();
  return (/** @type {PdEntry|PdDivider} */ entry) => {
    if (isDivider(entry)) return true;
    const msg = /** @type {PdEntry} */ (entry);
    if (hideGoodCrc && msg.type === 'GoodCRC') return false;
    if (needle === '') return true;
    if (msg.type.toLowerCase().includes(needle)) return true;
    if (displayType(msg.type).toLowerCase().includes(needle)) return true;
    if (msg.summary.toLowerCase().includes(needle)) return true;
    if ((msg.direction ?? '').toLowerCase().includes(needle)) return true;
    return false;
  };
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
  const matches = compilePdFilter(filterText, hideGoodCrc);
  for (let i = 0; i < entries.length; i++) {
    if (matches(entries[i])) out.push(i);
  }
  return out;
}

/**
 * Private incremental projection. Live append is folded on the next step; callers
 * publish indices and offsets together only when step() reports completion.
 * @param {(PdEntry|PdDivider)[]} entries @param {string} filterText
 * @param {boolean} hideGoodCrc @param {number} noteWidth @param {number} charWidth
 */
export function createPdProjection(entries, filterText, hideGoodCrc, noteWidth, charWidth) {
  const matches = compilePdFilter(filterText, hideGoodCrc);
  /** @type {number[]} */
  const indices = [];
  const offsets = [0];
  let through = 0;
  return {
    indices,
    offsets,
    step(maxRows = 512) {
      const end = Math.min(entries.length, through + Math.max(1, maxRows));
      for (; through < end; through++) {
        const entry = entries[through];
        if (!matches(entry)) continue;
        indices.push(through);
        offsets.push(offsets[offsets.length - 1] + rowHeightOf(entry, noteWidth, charWidth));
      }
      return through === entries.length;
    },
  };
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
 * Note 是否会在给定列宽下折成两行（只在空格处折，与 `.pd-col-note` 一致）。
 * @param {string} summary
 * @param {number} noteWidth
 * @param {number} charWidth
 */
export function noteUsesTwoLines(summary, noteWidth, charWidth) {
  if (!summary || noteWidth <= 0 || charWidth <= 0) return false;
  let lineW = 0;
  let started = false;
  const parts = summary.split(' ');
  for (const token of parts) {
    if (token === '') {
      if (started) {
        if (lineW + charWidth > noteWidth) return true;
        lineW += charWidth;
      }
      continue;
    }
    const tokenW = token.length * charWidth;
    if (!started) {
      lineW = tokenW;
      started = true;
      continue;
    }
    if (lineW + charWidth + tokenW > noteWidth) return true;
    lineW += charWidth + tokenW;
  }
  return false;
}

// Repeated summaries share metrics; cache capacity is independent of log length.
/** @type {Map<string, number>} */
const rowHeightCache = new Map();
let metricWidth = 0;
let metricAdvance = 0;

/** @param {PdEntry|PdDivider} entry @param {number} noteWidth @param {number} charWidth */
export function rowHeightOf(entry, noteWidth, charWidth) {
  if (isDivider(entry)) return PD_ROW_HEIGHT;
  const msg = /** @type {PdEntry} */ (entry);
  if (metricWidth !== noteWidth || metricAdvance !== charWidth) {
    rowHeightCache.clear();
    metricWidth = noteWidth;
    metricAdvance = charWidth;
  }
  const summary = msg.summary ?? '';
  const cached = rowHeightCache.get(summary);
  if (cached !== undefined) return cached;
  const height = noteUsesTwoLines(summary, noteWidth, charWidth) ? PD_ROW_HEIGHT_WRAP : PD_ROW_HEIGHT;
  if (rowHeightCache.size >= 4096) rowHeightCache.clear();
  rowHeightCache.set(summary, height);
  return height;
}

/**
 * `offsets[i]` 是第 i 行顶边，`offsets[n]` 是总高度。
 * @param {(PdEntry|PdDivider)[]} entries
 * @param {number[]} indices
 * @param {number} noteWidth
 * @param {number} charWidth
 * @returns {number[]}
 */
export function buildRowOffsets(entries, indices, noteWidth, charWidth) {
  /** @type {number[]} */
  const offsets = new Array(indices.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < indices.length; i++) {
    offsets[i + 1] = offsets[i] + rowHeightOf(entries[indices[i]], noteWidth, charWidth);
  }
  return offsets;
}

/**
 * 按前缀高度切片视口。`offsets` 长度须为 `n+1`。
 * @param {number[]} offsets
 * @param {number} scrollTop
 * @param {number} viewHeight
 * @param {number} [overscan=PD_OVERSCAN]
 */
export function visibleRangeByOffsets(offsets, scrollTop, viewHeight, overscan = PD_OVERSCAN) {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const vh = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : PD_ROW_HEIGHT;
  const start = Math.max(0, firstRowEndingAfter(offsets, top) - overscan);
  const end = Math.min(n, firstRowStartingAtOrAfter(offsets, top + vh) + overscan);
  return { start, end: Math.max(start, end) };
}

/** 第一个底边大于 y 的行。 */
function firstRowEndingAfter(offsets, y) {
  const n = offsets.length - 1;
  let lo = 0;
  let hi = n - 1;
  let ans = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] > y) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return Math.min(ans, Math.max(0, n - 1));
}

/** 第一个顶边 ≥ y 的行；没有则返回 n。 */
function firstRowStartingAtOrAfter(offsets, y) {
  const n = offsets.length - 1;
  let lo = 0;
  let hi = n;
  let ans = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] >= y) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
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
    for (const key of ['id', 'obj', 'rev', 'direction']) {
      const value = msg[/** @type {'id'|'obj'|'rev'|'direction'} */ (key)];
      if (value) out[key] = value;
    }
    if (Number.isFinite(msg.vbus)) out.vbus = msg.vbus;
    if (Number.isFinite(msg.ibus)) out.ibus = msg.ibus;
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
      copyBusSample(rec, entry);
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
    copyOptionalColumns(rec, entry);
    if (bytes) entry.bytes = bytes;
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * @param {Record<string, unknown>} rec
 * @param {PdEntry} entry
 */
function copyOptionalColumns(rec, entry) {
  for (const key of ['id', 'obj', 'rev', 'direction']) {
    const value = rec[key];
    if (typeof value === 'string') entry[/** @type {'id'|'obj'|'rev'|'direction'} */ (key)] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) {
      entry[/** @type {'id'|'obj'|'rev'|'direction'} */ (key)] = String(value);
    }
  }
  copyBusSample(rec, entry);
}

/**
 * @param {Record<string, unknown>} rec
 * @param {PdEntry} entry
 */
function copyBusSample(rec, entry) {
  for (const key of ['vbus', 'ibus']) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      entry[/** @type {'vbus'|'ibus'} */ (key)] = value;
    }
  }
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
    if (Number.isFinite(rec.gen)) entry.gen = /** @type {number} */ (rec.gen);
    copyBusSample(rec, entry);
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
    copyOptionalColumns(rec, entry);
    const bytes = normalizeBytes(rec.bytes);
    if (bytes) entry.bytes = bytes;
    if (Number.isFinite(rec.seq)) entry.seq = /** @type {number} */ (rec.seq);
    if (Number.isFinite(rec.gen)) entry.gen = /** @type {number} */ (rec.gen);
    return entry;
  }
  return null;
}
