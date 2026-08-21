import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyUiScale,
  clampUiScalePercent,
  previewUiScalePercent,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from '../src/ui-scale.js';

test('clamps non-finite values to the default', () => {
  assert.equal(clampUiScalePercent(undefined), UI_SCALE_DEFAULT);
  assert.equal(clampUiScalePercent(null), UI_SCALE_DEFAULT);
  assert.equal(clampUiScalePercent(Number.NaN), UI_SCALE_DEFAULT);
  assert.equal(clampUiScalePercent(Number.POSITIVE_INFINITY), UI_SCALE_DEFAULT);
  assert.equal(clampUiScalePercent(''), UI_SCALE_DEFAULT);
  assert.equal(clampUiScalePercent('abc'), UI_SCALE_DEFAULT);
});

test('clamps to the 50–200 range', () => {
  assert.equal(clampUiScalePercent(0), UI_SCALE_MIN);
  assert.equal(clampUiScalePercent(-20), UI_SCALE_MIN);
  assert.equal(clampUiScalePercent(300), UI_SCALE_MAX);
  assert.equal(clampUiScalePercent(1000), UI_SCALE_MAX);
});

test('rounds to the 5% step', () => {
  assert.equal(clampUiScalePercent(100), 100);
  assert.equal(clampUiScalePercent(77), 75);
  assert.equal(clampUiScalePercent(78), 80);
  assert.equal(clampUiScalePercent(67), 65);
  assert.equal(clampUiScalePercent('125'), 125);
  assert.equal(clampUiScalePercent(52.4), 50);
  assert.equal(clampUiScalePercent(52.5), 55);
});

test('applyUiScale returns the clamped percent without a DOM', async () => {
  assert.equal(await applyUiScale(80), 80);
  assert.equal(await applyUiScale(999), UI_SCALE_MAX);
  assert.equal(await applyUiScale('abc'), UI_SCALE_DEFAULT);
});

test('previewUiScalePercent clamps without applying zoom', () => {
  assert.equal(previewUiScalePercent(77), 75);
  assert.equal(previewUiScalePercent(999), UI_SCALE_MAX);
});
