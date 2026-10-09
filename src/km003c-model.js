// @ts-check
/**
 * @file POWER-Z 协议控制的纯逻辑：PDM 选项、各协议的表单规则、命令构造、日志格式。
 *
 * 不碰 DOM 与 Tauri，可在 `node --test` 里直接测；DOM 与调用后端在 views/trigger.js。
 * 命令的 JSON 形状与后端 `km003c::TriggerCommand` 一致（`type` 标签、蛇形字段名）。
 */

import { t } from './i18n.js';

/**
 * @typedef {{ pdType: number, em: number, sink: number }} PdmSettings
 * @typedef {{ type: string } & Record<string, unknown>} TriggerCommand
 * @typedef {{ position: number, kind: string, volt_min_mv: number, volt_max_mv: number,
 *   cur_ma?: number, label: string, programmable: boolean }} TriggerPdo
 * @typedef {{ id: string, label: string }} DetectedProtocol
 * @typedef {{ ok: boolean, message: string, pdos: TriggerPdo[], protocols: DetectedProtocol[],
 *   code?: string, pdm_open: boolean, description?: unknown }} TriggerOutcome
 * @typedef {{ position: number, voltMv: number, curMa: number, volt: string }} TriggerForm
 */

/** @type {{ value: number, label: string }[]} */
export const PD_TYPES = [
  { value: 0, label: 'Automatic' },
  { value: 1, label: 'PD 3.0' },
  { value: 2, label: 'PD 3.1' },
  { value: 3, label: 'Private PPS' },
];

/** @type {{ value: number, label: string }[]} */
export const EM_TYPES = [
  { value: 0, label: 'Off' },
  { value: 1, label: '20V 5A' },
  { value: 2, label: '50V 5A EPR' },
  { value: 3, label: 'LA135 6.75A' },
];

/** @type {{ value: number, label: string }[]} */
export const SINK_TYPES = [
  { value: 0, label: '3A PPS' },
  { value: 1, label: '5A PPS' },
];

/** @type {PdmSettings} */
export const DEFAULT_PDM = Object.freeze({ pdType: 1, em: 1, sink: 0 });

/** @param {unknown} raw @param {number} max @param {number} fallback */
function choice(raw, max, fallback) {
  // null / 空串 / 布尔不是「选了 0」，按缺失处理。
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

/**
 * 把持久化或表单里的 PDM 参数钳回合法取值；每个字段独立回落默认值。
 * @param {unknown} raw
 * @returns {PdmSettings}
 */
export function clampPdm(raw) {
  const source = /** @type {Partial<PdmSettings>} */ (raw && typeof raw === 'object' ? raw : {});
  return {
    pdType: choice(source.pdType, PD_TYPES.length - 1, DEFAULT_PDM.pdType),
    em: choice(source.em, EM_TYPES.length - 1, DEFAULT_PDM.em),
    sink: choice(source.sink, SINK_TYPES.length - 1, DEFAULT_PDM.sink),
  };
}

/** @type {{ id: string, label: string }[]} */
export const PROTOCOLS = [
  { id: 'pd', label: 'PD' },
  { id: 'qc', label: 'QC 2.0' },
  { id: 'qc3', label: 'QC 3.0' },
  { id: 'fcp', label: 'FCP' },
  { id: 'afc', label: 'AFC' },
  { id: 'sfcp', label: 'SFCP' },
  { id: 'scp', label: 'SCP' },
  { id: 'vfcp', label: 'VFCP' },
  { id: 'ufcs', label: 'UFCS' },
  { id: 'bc', label: 'BC 1.2' },
  { id: 'apple', label: 'Apple' },
];

export const QC_VOLTS = ['5V', '9V', '12V', '20V'];
export const FCP_VOLTS = ['5V', '9V', '12V'];

/**
 * 某个协议的触发表单要显示哪些字段。
 * @param {string} proto
 */
export function protocolFields(proto) {
  const fixedVolt = proto === 'qc' || proto === 'fcp' || proto === 'afc' || proto === 'sfcp';
  return {
    position: proto === 'pd' || proto === 'ufcs',
    positionLabel: t(proto === 'ufcs' ? 'requestPosition' : 'pdoPosition'),
    fixedVolt,
    voltChoices: proto === 'qc' ? QC_VOLTS : FCP_VOLTS,
    voltMv: proto === 'pd' || proto === 'qc3' || proto === 'scp' || proto === 'vfcp' || proto === 'ufcs',
    curMa: proto === 'pd' || proto === 'scp' || proto === 'vfcp' || proto === 'ufcs',
    qc3Adjust: proto === 'qc3',
  };
}

/** @param {unknown} value @param {number} min @param {number} max */
function intIn(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * 按表单构造一条触发命令；数值不合法时给出当前语言的原因，不发送。
 * @param {string} proto
 * @param {TriggerForm} form
 * @returns {{ cmd: TriggerCommand } | { error: string }}
 */
export function buildTriggerCommand(proto, form) {
  const fields = protocolFields(proto);
  if (fields.position && !intIn(form.position, 1, 15))
    return { error: t('positionInvalid', { field: fields.positionLabel }) };
  if (fields.voltMv && !intIn(form.voltMv, 0, 60000)) return { error: t('voltageInvalid') };
  if (fields.curMa && !intIn(form.curMa, 0, 10000)) return { error: t('currentInvalid') };
  if (fields.fixedVolt && !fields.voltChoices.includes(form.volt)) return { error: t('selectVoltage') };
  const position = Number(form.position);
  const voltMv = Number(form.voltMv);
  const curMa = Number(form.curMa);
  switch (proto) {
    case 'pd':
      return { cmd: { type: 'pd_req', position, volt_mv: voltMv, cur_ma: curMa } };
    case 'qc':
      return { cmd: { type: 'qc', voltage: form.volt } };
    case 'qc3':
      return { cmd: { type: 'qc3', volt_mv: voltMv } };
    case 'fcp':
    case 'afc':
    case 'sfcp':
      return { cmd: { type: proto, voltage: form.volt } };
    case 'scp':
    case 'vfcp':
      return { cmd: { type: proto, volt_mv: voltMv, cur_ma: curMa } };
    case 'ufcs':
      return { cmd: { type: 'ufcs', req: position, volt_mv: voltMv, cur_ma: curMa } };
    case 'bc':
    case 'apple':
      return { cmd: { type: 'entry', protocol: proto } };
    default:
      return { error: t('unknownProtocol', { protocol: proto }) };
  }
}

/**
 * 清洗 `pd data` 的十六进制：只留十六进制字符，要求偶数位且至少 1 字节。
 * @param {string} text
 * @returns {string|null}
 */
export function cleanHex(text) {
  const hex = String(text ?? '').replace(/[^0-9a-fA-F]/g, '');
  return hex.length >= 2 && hex.length % 2 === 0 ? hex.toUpperCase() : null;
}

/**
 * 前端等待一条命令的上限。后端串口超时是 list 90 s、list+ 180 s、其余 12 s 以内，
 * 这里多留余量，只作为界面兜底，不会先于后端放弃。
 * @param {TriggerCommand} cmd
 */
export function triggerTimeoutMs(cmd) {
  if (cmd.type === 'list') return cmd.plus ? 210_000 : 120_000;
  return 45_000;
}

/**
 * 不需要先打开 PDM 的命令：打开 / 关闭 PDM 与自定义原始命令。
 * @param {TriggerCommand} cmd
 */
export function commandNeedsPdm(cmd) {
  return cmd.type !== 'pdm_open' && cmd.type !== 'pdm_close' && cmd.type !== 'raw';
}

export const LOG_LIMIT = 64_000;

/**
 * 一条结果的标题：列表检测显示「检测完成」，其余 OK / ERR。
 * @param {TriggerOutcome} outcome
 */
export function outcomeHead(outcome) {
  const listed = outcome.protocols.length > 0;
  const looksLikeList = /:\s*(OK|FAIL|n\/a)/i.test(outcome.message);
  if (!(outcome.ok || listed)) return 'ERR';
  return listed || looksLikeList ? t('scanComplete') : 'OK';
}

/**
 * 把一条结果加到日志顶部（最新在上），超长时截掉最旧的部分。
 * 回复为空时用已经流式收到的进度行代替，避免「(无回复)」盖住真实输出。
 * @param {string} log
 * @param {TriggerOutcome} outcome
 * @param {string} progress
 * @param {string} time
 */
export function prependOutcome(log, outcome, progress, time) {
  const raw = (outcome.message ?? '').trim();
  const empty = !raw;
  const body = empty && progress.trim() ? progress.trim() : raw;
  return prependLog(log, `[${time}] ${outcomeHead(outcome)}\n${body}`);
}

/**
 * @param {string} log
 * @param {string} entry
 */
export function prependLog(log, entry) {
  return `${entry}\n\n${log}`.trim().slice(0, LOG_LIMIT);
}

/** @type {Record<string, string>} */
const PDO_KIND_LABELS = {
  fixed: 'Fixed',
  epr_fixed: 'EPR Fixed',
  pps: 'PPS',
  avs: 'AVS',
  spr_avs: 'SPR AVS',
  epr_avs: 'EPR AVS',
  battery: 'Battery',
  variable: 'Variable',
};

/** @param {number} mv */
const volts = (mv) => (mv / 1000).toFixed(2);

/**
 * PDO 表格的一行文字。
 * @param {TriggerPdo} pdo
 */
export function describePdo(pdo) {
  const range = pdo.volt_min_mv === pdo.volt_max_mv;
  return {
    position: `#${pdo.position}`,
    kind: PDO_KIND_LABELS[pdo.kind] ?? pdo.kind,
    voltage: range ? `${volts(pdo.volt_max_mv)} V` : `${volts(pdo.volt_min_mv)}–${volts(pdo.volt_max_mv)} V`,
    current: Number.isFinite(pdo.cur_ma) ? `${volts(/** @type {number} */ (pdo.cur_ma))} A` : '—',
  };
}

/**
 * 点选 PDO 后填入的请求：固定档取其电压；可编程档把当前电压钳进范围。
 * 电流取 PDO 标称值，缺省时保留表单原值。
 * @param {TriggerPdo} pdo
 * @param {TriggerForm} current
 * @returns {{ proto: 'pd', position: number, voltMv: number, curMa: number }}
 */
export function pdoToRequestFields(pdo, current) {
  const voltMv = pdo.programmable
    ? Math.min(pdo.volt_max_mv, Math.max(pdo.volt_min_mv, Number(current.voltMv) || pdo.volt_min_mv))
    : pdo.volt_max_mv;
  return {
    proto: 'pd',
    position: pdo.position,
    voltMv,
    curMa: Number.isFinite(pdo.cur_ma) ? /** @type {number} */ (pdo.cur_ma) : Number(current.curMa),
  };
}

/**
 * 设备是否提供协议控制。旧后端 / 测量台桩没有 family 字段时按维简处理。
 * @param {{ family?: string, controls?: boolean } | null | undefined} info
 */
export function deviceSupportsControl(info) {
  return !!info && info.family === 'km003c' && info.controls !== false;
}
