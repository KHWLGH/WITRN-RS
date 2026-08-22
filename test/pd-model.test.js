import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bitsToHexWord,
  buildRowOffsets,
  directionClass,
  directionOf,
  displayType,
  filterIndices,
  findChild,
  formatBusVI,
  formatCapNote,
  formatElapsed,
  formatRequestNote,
  headerFields,
  hexWordsFromWire,
  matchesFilter,
  msgTypeClass,
  NOTE_NB_HYPHEN,
  nextMessageIndex,
  normalizePdPayload,
  noteUsesTwoLines,
  objectTables,
  PD_ROW_HEIGHT,
  PD_ROW_HEIGHT_WRAP,
  pdWireBytes,
  powerRoleClass,
  protectNoteToken,
  rowHeightOf,
  sessionOrigin,
  summarize,
  visibleRange,
  visibleRangeByOffsets,
} from '../src/pd-model.js';

/** 构造一个叶子节点。 */
function leaf(field, value, raw = '0', bitLoc = [0, 0]) {
  return { raw, bit_loc: bitLoc, field, value };
}

/** 构造一个容器节点。 */
function node(field, children, extra = {}) {
  return { raw: '0', bit_loc: null, field, value: children, ...extra };
}

/** 仿真 usbpd-parser 序列化出的 Source_Capabilities 报文树。 */
function sourceCapabilities() {
  return node('Source_Capabilities', [
    leaf('SOP*', 'SOP'),
    node('Message Header', [
      leaf('Extended', false),
      leaf('Number of Data Objects', 2),
      leaf('MessageID', 0),
      leaf('Port Power Role', 'Source', '1', [8, 8]),
      leaf('Specification Revision', 'Rev 3.x'),
      leaf('Port Data Role', 'DFP'),
      leaf('Message Type', 'Source_Capabilities'),
    ]),
    node('Data Objects', [
      node('PDO 1', [leaf('Voltage', 100)], { quick_pdo: 'F 5.0V@3.0A' }),
      node('PDO 2', [leaf('Voltage', 180)], { quick_pdo: 'F 9.0V@2.2A' }),
    ]),
  ]);
}

function goodCrc() {
  return node('GoodCRC', [
    leaf('SOP*', 'SOP'),
    node('Message Header', [leaf('Message Type', 'GoodCRC'), leaf('Port Power Role', 'Sink', '0', [8, 8])]),
  ]);
}

function cableMessage() {
  return node('Discover_Identity', [
    leaf('SOP*', "SOP'"),
    node('Message Header', [leaf('Message Type', 'Vendor_Defined'), leaf('Cable Plug', 'Cable Plug or VPD')]),
  ]);
}

test('summarize extracts sop/type/role/summary from a capabilities tree', () => {
  const s = summarize(sourceCapabilities());
  assert.equal(s.sop, 'SOP');
  assert.equal(s.type, 'Source_Capabilities');
  assert.equal(s.role, 'SRC');
  assert.equal(s.summary, 'Fixed: 5.0V 9.0V');
  assert.equal(s.id, '0');
  assert.equal(s.obj, '2');
  assert.equal(s.rev, 'V3');
  assert.equal(s.direction, 'SRC→SNK');
});

test('summarize maps sink role and cable plug', () => {
  const crc = summarize(goodCrc());
  assert.equal(crc.role, 'SNK');
  assert.equal(crc.direction, 'SRC←SNK');
  const cable = summarize(cableMessage());
  assert.equal(cable.role, 'CBL');
  assert.equal(cable.sop, "SOP'");
  assert.equal(cable.direction, 'SRC|SNK←Plug');
});

test('summarize tolerates missing header', () => {
  const s = summarize(node('Broken', [leaf('SOP*', 'SOP')]));
  assert.equal(s.type, '未知');
  assert.equal(s.role, '');
  assert.equal(s.summary, '');
});

test('findChild only matches direct children', () => {
  const tree = sourceCapabilities();
  assert.equal(findChild(tree, 'Message Header')?.field, 'Message Header');
  assert.equal(findChild(tree, 'Message Type'), null);
});

test('matchesFilter hides GoodCRC and filters by type substring', () => {
  const cap = { t: 0, ...summarize(sourceCapabilities()), meta: sourceCapabilities() };
  const crc = { t: 0, ...summarize(goodCrc()), meta: goodCrc() };
  assert.equal(matchesFilter(crc, '', true), false);
  assert.equal(matchesFilter(crc, '', false), true);
  assert.equal(matchesFilter(cap, 'source_cap', true), true);
  assert.equal(matchesFilter(cap, 'request', true), false);
  assert.equal(matchesFilter({ t: 0, divider: true }, 'request', true), true);
});

test('filterIndices keeps dividers and hides GoodCRC', () => {
  const cap = { t: 0, ...summarize(sourceCapabilities()), meta: sourceCapabilities() };
  const crc = { t: 0, ...summarize(goodCrc()), meta: goodCrc() };
  const div = { t: 1, divider: true };
  const entries = [cap, crc, div];
  assert.deepEqual(filterIndices(entries, '', true), [0, 2]);
  assert.deepEqual(filterIndices(entries, 'request', true), [2]);
  assert.deepEqual(filterIndices(entries, '', false), [0, 1, 2]);
});

test('visibleRange only covers the viewport plus overscan', () => {
  const { start, end } = visibleRange(10_000, 240, 120, 24, 2);
  assert.equal(start, 8);
  assert.equal(end, 17);
  assert.deepEqual(visibleRange(0, 0, 100), { start: 0, end: 0 });
});

test('noteUsesTwoLines wraps only at spaces', () => {
  assert.equal(noteUsesTwoLines('', 100, 7), false);
  assert.equal(noteUsesTwoLines('Fixed: 5.0V', 200, 7), false);
  assert.equal(noteUsesTwoLines('Fixed: 5.0V 9.0V', 10 * 7, 7), true);
  assert.equal(noteUsesTwoLines('Fixed: 5.0V 9.0V', 20 * 7, 7), false);
});

test('row offsets distinguish single-line and wrapped rows', () => {
  const short = { t: 0, sop: 'SOP', type: 'Accept', role: 'SRC', summary: 'ok' };
  const long = { t: 1, sop: 'SOP', type: 'Source_Capabilities', role: 'SRC', summary: 'Fixed: 5.0V 9.0V 12.0V' };
  const div = { t: 2, divider: true };
  assert.equal(rowHeightOf(short, 10 * 7, 7), PD_ROW_HEIGHT);
  assert.equal(rowHeightOf(long, 10 * 7, 7), PD_ROW_HEIGHT_WRAP);
  assert.equal(rowHeightOf(div, 10 * 7, 7), PD_ROW_HEIGHT);
  const offsets = buildRowOffsets([short, long, div], [0, 1, 2], 10 * 7, 7);
  assert.deepEqual(offsets, [
    0,
    PD_ROW_HEIGHT,
    PD_ROW_HEIGHT + PD_ROW_HEIGHT_WRAP,
    2 * PD_ROW_HEIGHT + PD_ROW_HEIGHT_WRAP,
  ]);
});

test('visibleRangeByOffsets walks mixed row heights', () => {
  const offsets = [0, 24, 64, 88, 112];
  assert.deepEqual(visibleRangeByOffsets(offsets, 0, 24, 0), { start: 0, end: 1 });
  assert.deepEqual(visibleRangeByOffsets(offsets, 24, 40, 0), { start: 1, end: 2 });
  assert.deepEqual(visibleRangeByOffsets(offsets, 20, 50, 0), { start: 0, end: 3 });
  assert.deepEqual(visibleRangeByOffsets([0], 0, 100, 0), { start: 0, end: 0 });
});

test('directionOf distinguishes DFP-to-plug from plug-to-host', () => {
  const toPlug = node('Message Header', [leaf('Cable Plug', 'DFP or UFP')]);
  const fromPlug = node('Message Header', [leaf('Cable Plug', 'Cable Plug or VPD')]);
  assert.equal(directionOf("SOP'", 'CBL', toPlug), 'SRC|SNK→Plug');
  assert.equal(directionOf("SOP''", 'CBL', fromPlug), 'SRC|SNK←Plug');
});

test('formatCapNote groups Fixed / PPS / AVS', () => {
  assert.equal(
    formatCapNote(['F 5.0V@3.0A', 'F 9.0V@3.0A', 'SA 9-15V@3.0A 15-20V@5.0A', 'P 5.0-21.0V@5.0A']),
    `Fixed: 5.0V 9.0V  SPR AVS: 9${NOTE_NB_HYPHEN}15V@3.0A 15${NOTE_NB_HYPHEN}20V@5.0A  PPS: 5.0${NOTE_NB_HYPHEN}21.0V`,
  );
});

test('protectNoteToken only replaces digit-digit hyphens', () => {
  assert.equal(protectNoteToken('5.0-21.0V'), `5.0${NOTE_NB_HYPHEN}21.0V`);
  assert.equal(protectNoteToken('Fixed: 5.0V'), 'Fixed: 5.0V');
});

test('formatRequestNote reads object position and supply', () => {
  assert.equal(formatRequestNote('[1] F 5.0V@2.0A'), 'Position:1 Fixed:5.0V,2.0A');
  assert.equal(formatRequestNote('[8] EF 28.0V@5.0A'), 'Position:8 EPR Fixed:28.0V,5.0A');
  assert.equal(formatRequestNote('9V 2A'), '9V 2A');
});

test('displayType and msgTypeClass cover the handshake set', () => {
  assert.equal(displayType('Source_Capabilities'), 'Source Cap');
  assert.equal(displayType('Vendor_Defined'), 'Vendor Defined');
  assert.equal(displayType('GoodCRC'), 'GoodCRC');
  assert.equal(msgTypeClass('Request'), 'pd-msg-request');
  assert.equal(msgTypeClass('Accept'), 'pd-msg-accept');
  assert.equal(msgTypeClass('Vendor_Defined'), 'pd-msg-vdm');
  assert.equal(msgTypeClass('Ping'), 'pd-msg-ping');
  assert.equal(msgTypeClass('Get_Source_Cap'), 'pd-msg-get');
  assert.equal(msgTypeClass('PR_Swap'), 'pd-msg-swap');
  assert.equal(msgTypeClass('Alert'), 'pd-msg-alert');
  assert.equal(msgTypeClass('Enter_USB'), 'pd-msg-mode');
  assert.equal(msgTypeClass('Manufacturer_Info'), 'pd-msg-ext');
  assert.equal(msgTypeClass('Reserved'), 'pd-msg-other');
});

test('direction and power role use color classes, not new arrow glyphs', () => {
  assert.equal(directionClass('SRC→SNK'), 'pd-dir-src');
  assert.equal(directionClass('SRC←SNK'), 'pd-dir-snk');
  assert.equal(directionClass('SRC|SNK→Plug'), 'pd-dir-plug');
  assert.equal(powerRoleClass('Source'), 'pd-dir-src');
  assert.equal(powerRoleClass('Sink'), 'pd-dir-snk');
});

test('formatBusVI requires both samples', () => {
  assert.equal(formatBusVI(5.097, 0.044), '5.097V/0.044A');
  assert.equal(formatBusVI(5, undefined), '');
  assert.equal(formatBusVI(Number.NaN, 1), '');
});

test('formatElapsed is relative to the session origin', () => {
  assert.equal(formatElapsed(6_197, 0), '0:00:06.197');
  assert.equal(formatElapsed(3_661_150, 0), '1:01:01.150');
  assert.equal(formatElapsed(100, 200), '0:00:00.000');
  assert.equal(
    sessionOrigin([
      { t: 10, divider: true },
      { t: 25, sop: 'SOP', type: 'A', role: '', summary: '' },
    ]),
    25,
  );
});

test('hex words follow USB-PD little-endian object layout', () => {
  assert.deepEqual(pdWireBytes([0xfe, 0x03, 224, 0x41, 0x00]), [0x41, 0x00]);
  assert.deepEqual(hexWordsFromWire([0xa1, 0x71, 0x2c, 0x91, 0x81, 0x0a]), [
    { label: 'Msg Header', hex: '0x71A1' },
    { label: 'Data Object 0', hex: '0x0A81912C' },
  ]);
  assert.equal(bitsToHexWord('0111000110100001'), '0x71A1');
  assert.deepEqual(hexWordsFromWire([0xa1, 0x91, 0x10, 0x80, 0x2c, 0x91, 0x01, 0x08, 0xaa]), [
    { label: 'Msg Header', hex: '0x91A1' },
    { label: 'Ext Header', hex: '0x8010' },
    { label: 'Data Object 0', hex: '0x0801912C' },
    { label: 'Data', hex: '0xAA' },
  ]);
});

test('headerFields and objectTables flatten the decode tree', () => {
  const caps = sourceCapabilities();
  assert.deepEqual(
    headerFields(caps).map((f) => f.label),
    ['Extended', 'Objects', 'Msg ID', 'Power Role', 'Spec Rev', 'Data Role', 'Msg Type'],
  );
  const tables = objectTables(caps);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].chip, '5.0V,3.0A');
  assert.equal(tables[0].fields[0].label, 'Voltage');
  assert.equal(headerFields(caps).find((f) => f.label === 'Power Role')?.className, 'pd-dir-src');
});

test('objectTables recurses nested VDM containers instead of dropping them', () => {
  const vdm = node('Vendor_Defined', [
    leaf('SOP*', 'SOP'),
    node('Data Objects', [
      node('VDM Header', [
        leaf('Command', 'Discover Identity'),
        node('ID Header VDO', [leaf('USB Vendor ID', '0x05AC')]),
      ]),
    ]),
  ]);
  const tables = objectTables(vdm);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].title, 'VDM Header');
  assert.equal(tables[0].fields[0].value, 'Discover Identity');
  assert.equal(tables[1].title, 'VDM Header / ID Header VDO');
  assert.equal(tables[1].fields[0].label, 'USB Vendor ID');
});

test('normalizePdPayload keeps last bus sample', () => {
  const entry = normalizePdPayload({
    t: 1,
    sop: 'SOP',
    type: 'GoodCRC',
    role: 'SNK',
    summary: '',
    vbus: 5.097,
    ibus: 0.044,
  });
  assert.ok(entry && !('divider' in entry && entry.divider));
  assert.equal(/** @type {import('../src/pd-model.js').PdEntry} */ (entry).vbus, 5.097);
  assert.equal(/** @type {import('../src/pd-model.js').PdEntry} */ (entry).ibus, 0.044);
});

test('matchesFilter also hits the display name and note', () => {
  const cap = { t: 0, ...summarize(sourceCapabilities()), meta: sourceCapabilities() };
  assert.equal(matchesFilter(cap, 'source cap', true), true);
  assert.equal(matchesFilter(cap, 'fixed: 5.0v', true), true);
  assert.equal(matchesFilter(cap, 'src→snk', true), true);
});

test('nextMessageIndex skips dividers', () => {
  const entries = [
    { t: 0, divider: true },
    { t: 1, sop: 'SOP', type: 'A', role: '', summary: '' },
    { t: 2, divider: true },
    { t: 3, sop: 'SOP', type: 'B', role: '', summary: '' },
  ];
  const indices = [0, 1, 2, 3];
  assert.equal(nextMessageIndex(entries, indices, 0, 1), 1);
  assert.equal(nextMessageIndex(entries, indices, 1, 1), 3);
  assert.equal(nextMessageIndex(entries, indices, 3, 1), -1);
  assert.equal(nextMessageIndex(entries, indices, 3, -1), 1);
});
