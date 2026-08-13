import assert from 'node:assert/strict';
import test from 'node:test';
import { createRing, findChild, matchesFilter, summarize } from '../src/pd-model.js';

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

test('ring buffer wraps around and counts drops', () => {
  const ring = createRing(3);
  for (let i = 1; i <= 5; i++) ring.push(i);
  assert.equal(ring.length, 3);
  assert.equal(ring.dropped, 2);
  assert.deepEqual(ring.toArray(), [3, 4, 5]);
  ring.clear();
  assert.equal(ring.length, 0);
  assert.equal(ring.dropped, 0);
  ring.push(9);
  assert.deepEqual(ring.toArray(), [9]);
});
