import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyChartColumns, F64Col } from '../src/state.js';

test('F64Col push crosses fixed chunks without moving prior values', () => {
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

test('F64Col snapshots retain exact boundary values after append and replacement', () => {
  const col = new F64Col();
  for (let i = 0; i < 4097; i++) col.push(i === 4095 ? -0 : i === 4096 ? Number.NaN : i);
  const snapshot = col.snapshot();
  const firstBuffer = snapshot.chunks().next().value.values.buffer;
  col.push(Infinity);
  assert.equal(col._chunks[0].buffer, firstBuffer);
  assert.equal(snapshot.length, 4097);
  assert.ok(Object.is(snapshot.valueAt(4095), -0));
  assert.ok(Number.isNaN(snapshot.valueAt(4096)));
  assert.equal(snapshot.valueAt(4097), undefined);
  assert.deepEqual(
    [...snapshot.chunks()].map(({ values }) => values.length),
    [4096, 1],
  );
  col.setAt(4095, 7);
  assert.ok(Object.is(snapshot.valueAt(4095), -0));
  col.set([8]);
  assert.equal(snapshot.valueAt(0), 0);
  assert.equal(col.valueAt(0), 8);
  assert.equal(col.byteLength, 4096 * 8);
});

test('F64Col.set copies an array-like and view matches length', () => {
  const col = new F64Col(1);
  col.set([10, 20, 30, 40]);
  assert.equal(col.length, 4);
  assert.equal(col.at(-1), 40);
  assert.deepEqual(Array.from(col.view()), [10, 20, 30, 40]);
});

test('F64Col.set leaves the live column intact if copying fails', () => {
  const col = new F64Col();
  col.set([1, 2]);
  const revision = col.revision;
  const source = {
    length: 4097,
    get 0() {
      throw new Error('source failed');
    },
  };
  assert.throws(() => col.set(source), /source failed/);
  assert.deepEqual(col.view(), new Float64Array([1, 2]));
  assert.equal(col.revision, revision);
});

test('emptyChartColumns starts empty and aligned', () => {
  const cols = emptyChartColumns(8);
  assert.equal(cols.x.length, 0);
  cols.x.push(1.5);
  cols.voltage.push(5);
  assert.equal(cols.x.at(-1), 1.5);
  assert.equal(cols.voltage.length, 1);
});
