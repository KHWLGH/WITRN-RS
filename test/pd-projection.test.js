import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRowOffsets, createPdProjection, filterIndices, rowHeightOf } from '../src/pd-model.js';

test('batched filtering/layout includes live appends once and keeps source log unchanged', () => {
  const entries = Array.from({ length: 14017 }, (_, i) =>
    i % 101 === 0
      ? { divider: true, t: i }
      : {
          t: i,
          type: i % 2 ? 'GoodCRC' : 'Source_Capabilities',
          sop: 'SOP',
          role: 'SRC',
          summary: i % 3 ? 'Fixed: 5V 9V 15V 20V PPS: 3.3-21V' : '',
        },
  );
  const projection = createPdProjection(entries, ' FIXED ', true, 140, 7);
  projection.step(512);
  entries.push({ t: 99999, type: 'Source_Capabilities', summary: 'Fixed: 24V', sop: 'SOP', role: 'SRC' });
  const before = structuredClone(entries);
  while (!projection.step(127)) {}
  const expected = filterIndices(entries, ' FIXED ', true);
  assert.deepStrictEqual(projection.indices, expected);
  assert.deepStrictEqual(projection.offsets, buildRowOffsets(entries, expected, 140, 7));
  assert.deepStrictEqual(entries, before);
  assert.equal(projection.indices.at(-1), entries.length - 1);
});

test('cached row metrics invalidate on width, font advance and summary changes', () => {
  const entry = { t: 1, type: 'Request', summary: 'a b c', sop: 'SOP', role: 'SRC' };
  const narrow = rowHeightOf(entry, 10, 7);
  const wide = rowHeightOf(entry, 100, 7);
  assert.ok(narrow > wide);
  assert.equal(rowHeightOf(entry, 100, 30), narrow);
  entry.summary = 'a';
  assert.equal(rowHeightOf(entry, 100, 30), wide);
});
