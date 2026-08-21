import assert from 'node:assert/strict';
import test from 'node:test';
import { filterIndices, findChild, matchesFilter, nextMessageIndex, summarize, visibleRange } from '../src/pd-model.js';

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
      leaf('Message Type', 'Source_Capabilities'),
      leaf('Port Power Role', 'Source', '1', [8, 8]),
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
  assert.equal(s.summary, 'F 5.0V@3.0A  F 9.0V@2.2A');
});

test('summarize maps sink role and cable plug', () => {
  assert.equal(summarize(goodCrc()).role, 'SNK');
  const cable = summarize(cableMessage());
  assert.equal(cable.role, 'CBL');
  assert.equal(cable.sop, "SOP'");
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
