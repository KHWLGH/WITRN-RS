import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyChartColumns, F64Col } from '../src/state.js';

test('F64Col push grows by doubling and keeps values', () => {
  const col = new F64Col(2);
  col.push(1);
  col.push(2);
  col.push(3);
  assert.equal(col.length, 3);
  assert.equal(col.at(0), 1);
  assert.equal(col.at(1), 2);
  assert.equal(col.at(-1), 3);
  assert.equal(col.view().length, 3);
  assert.ok(col.buf.length >= 3);
  assert.ok(col.view() instanceof Float64Array);
});

test('F64Col.set copies an array-like and view matches length', () => {
  const col = new F64Col(1);
  col.set([10, 20, 30, 40]);
  assert.equal(col.length, 4);
  assert.equal(col.at(-1), 40);
  assert.deepEqual(Array.from(col.view()), [10, 20, 30, 40]);
});

test('emptyChartColumns starts empty and aligned', () => {
  const cols = emptyChartColumns(8);
  assert.equal(cols.x.length, 0);
  cols.x.push(1.5);
  cols.voltage.push(5);
  assert.equal(cols.x.at(-1), 1.5);
  assert.equal(cols.voltage.length, 1);
});
