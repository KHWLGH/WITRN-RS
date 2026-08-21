import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeThemePreference, resolveTheme } from '../src/theme.js';

test('normalizeThemePreference keeps the three valid values', () => {
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('system'), 'system');
});

test('normalizeThemePreference falls back to dark', () => {
  assert.equal(normalizeThemePreference(undefined), 'dark');
  assert.equal(normalizeThemePreference(null), 'dark');
  assert.equal(normalizeThemePreference(''), 'dark');
  assert.equal(normalizeThemePreference('auto'), 'dark');
  assert.equal(normalizeThemePreference('LIGHT'), 'dark');
});

test('resolveTheme maps a fixed preference to itself', () => {
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
});

test('resolveTheme follows the system appearance when preference is system', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('resolveTheme treats a bad preference as dark', () => {
  assert.equal(resolveTheme('auto', false), 'dark');
  assert.equal(resolveTheme(undefined, false), 'dark');
});
