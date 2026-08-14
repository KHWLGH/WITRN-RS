import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPdCaptureFile, parsePdCaptureFile, summarize } from '../src/pd-model.js';

/** 一棵最小但真实形状的解码树（Request 消息 + quick_rdo）。 */
const meta = {
  raw: '10000010',
  bit_loc: [0, 7],
  field: 'PD',
  value: [
    { raw: '111', bit_loc: null, field: 'SOP*', value: 'SOP' },
    {
      raw: '1000010',
      bit_loc: [0, 15],
      field: 'Message Header',
      value: [
        { raw: '0010', bit_loc: [0, 4], field: 'Message Type', value: 'Request' },
        { raw: '0', bit_loc: [8, 8], field: 'Port Power Role', value: 'Sink' },
      ],
    },
    {
      raw: '1',
      bit_loc: [16, 47],
      field: 'Data Objects',
      value: [{ raw: '1', bit_loc: [16, 47], field: 'RDO', value: null, quick_rdo: '9V 2A' }],
    },
  ],
};

const entry = { t: 1_000_000, ...summarize(meta), meta };
const divider = { t: 1_000_001, divider: true };

test('capture file round-trips entries and dividers', () => {
  const file = buildPdCaptureFile([entry, divider]);
  assert.equal(file.kind, 'pd-capture');
  assert.equal(file.version, 1);

  const parsed = parsePdCaptureFile(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0], entry);
  assert.deepEqual(parsed.entries[1], divider);
});

test('summaries are recomputed from meta on import', () => {
  const file = JSON.parse(JSON.stringify(buildPdCaptureFile([entry])));
  file.entries[0].type = '被手改的类型';
  file.entries[0].summary = '被手改的摘要';

  const parsed = parsePdCaptureFile(file);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries[0].type, 'Request');
  assert.equal(parsed.entries[0].summary, '9V 2A');
});

test('rejects wrong kind, version, and shapes', () => {
  assert.equal(parsePdCaptureFile(null).ok, false);
  assert.equal(parsePdCaptureFile([]).ok, false);
  assert.equal(parsePdCaptureFile({ kind: 'other', version: 1, entries: [] }).ok, false);
  assert.equal(parsePdCaptureFile({ kind: 'pd-capture', version: 2, entries: [] }).ok, false);
  assert.equal(parsePdCaptureFile({ kind: 'pd-capture', version: 1, entries: {} }).ok, false);
});

test('rejects malformed entries', () => {
  const base = { kind: 'pd-capture', version: 1 };
  // 缺时间戳
  assert.equal(parsePdCaptureFile({ ...base, entries: [{ meta }] }).ok, false);
  // NaN 时间戳（JSON 里写不出 NaN，但防御手工构造对象）
  assert.equal(parsePdCaptureFile({ ...base, entries: [{ t: Number.NaN, meta }] }).ok, false);
  // meta 缺 field
  assert.equal(
    parsePdCaptureFile({ ...base, entries: [{ t: 1, meta: { raw: '0', bit_loc: null, value: null } }] }).ok,
    false,
  );
  // bit_loc 形状不对
  assert.equal(
    parsePdCaptureFile({ ...base, entries: [{ t: 1, meta: { raw: '0', bit_loc: [1], field: 'x', value: null } }] }).ok,
    false,
  );
  // value 类型非法
  assert.equal(
    parsePdCaptureFile({ ...base, entries: [{ t: 1, meta: { raw: '0', bit_loc: null, field: 'x', value: {} } }] }).ok,
    false,
  );
});

test('rejects trees deeper than the recursion cap', () => {
  /** @type {any} */
  let deep = { raw: '0', bit_loc: null, field: 'leaf', value: null };
  for (let i = 0; i < 40; i++) {
    deep = { raw: '0', bit_loc: null, field: `n${i}`, value: [deep] };
  }
  const parsed = parsePdCaptureFile({ kind: 'pd-capture', version: 1, entries: [{ t: 1, meta: deep }] });
  assert.equal(parsed.ok, false);
});

test('accepts an empty capture', () => {
  const parsed = parsePdCaptureFile(buildPdCaptureFile([]));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries, []);
});
