// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { normalizeWindowStyle, resolveWindowStyle, WINDOW_STYLE_STORAGE_KEY } from '../src/window-style.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME_BOOT = readFileSync(path.join(root, 'src/theme-boot.js'), 'utf8');

const USER_AGENTS = {
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/140.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

/**
 * Runs theme-boot.js against a minimal page and returns the attributes it wrote.
 * @param {string} userAgent
 * @param {string|null} storedStyle
 */
function bootAttributes(userAgent, storedStyle) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  const documentElement = {
    /** @param {string} name @param {string} value */
    setAttribute: (name, value) => attributes.set(name, String(value)),
    /** @param {string} name */
    getAttribute: (name) => attributes.get(name) ?? null,
  };
  const storage = { [WINDOW_STYLE_STORAGE_KEY]: storedStyle };
  vm.runInNewContext(THEME_BOOT, {
    document: { documentElement },
    navigator: { userAgent },
    localStorage: { getItem: (/** @type {string} */ key) => storage[key] ?? null },
    window: { matchMedia: () => ({ matches: true }) },
  });
  return attributes;
}

test('未知偏好归一为跟随平台', () => {
  for (const value of [undefined, null, '', 'linux', 'Mac', 1]) {
    assert.equal(normalizeWindowStyle(value), 'auto');
  }
  assert.equal(normalizeWindowStyle('windows'), 'windows');
  assert.equal(normalizeWindowStyle('macos'), 'macos');
});

test('macOS 使用系统红绿灯，任何偏好都解析为 macOS 布局', () => {
  for (const preference of ['auto', 'windows', 'macos', 'bogus']) {
    assert.equal(resolveWindowStyle(preference, 'macos'), 'macos');
  }
});

test('Windows / Linux 按偏好换皮肤，跟随平台时为 Windows 风格', () => {
  for (const os of ['windows', 'linux']) {
    assert.equal(resolveWindowStyle('auto', os), 'windows');
    assert.equal(resolveWindowStyle('windows', os), 'windows');
    assert.equal(resolveWindowStyle('macos', os), 'macos');
  }
});

test('首帧引导与 resolveWindowStyle 判定一致，Mac 首帧不会先排成 Windows 布局', () => {
  for (const [os, userAgent] of Object.entries(USER_AGENTS)) {
    for (const stored of [null, 'auto', 'windows', 'macos', 'bogus']) {
      const attributes = bootAttributes(userAgent, stored);
      assert.equal(attributes.get('data-os'), os, userAgent);
      assert.equal(
        attributes.get('data-window-style'),
        resolveWindowStyle(stored, os),
        `${os} 首帧，已存偏好 ${stored}`,
      );
    }
  }
});
