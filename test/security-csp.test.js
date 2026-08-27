import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 安全契约：dialog 能力只开放文件打开/保存，CSP 的 script-src / style-src
 * 不含 'unsafe-inline'。漏改一处不会有构建失败，只能靠这里抓住。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel @returns {string} */
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('dialog capability is open+save only', () => {
  const capabilities = JSON.parse(read('src-tauri/capabilities/default.json'));
  const permissions = capabilities.permissions;
  assert.ok(Array.isArray(permissions), 'capabilities.permissions 必须是数组');
  assert.ok(permissions.includes('dialog:allow-open'), '缺少 dialog:allow-open');
  assert.ok(permissions.includes('dialog:allow-save'), '缺少 dialog:allow-save');
  for (const forbidden of ['dialog:default', 'dialog:allow-message', 'dialog:allow-ask']) {
    assert.ok(!permissions.includes(forbidden), `不应再授予 ${forbidden}`);
  }
});

test('CSP script-src and style-src omit unsafe-inline', () => {
  const csp = JSON.parse(read('src-tauri/tauri.conf.json')).app?.security?.csp;
  assert.equal(typeof csp, 'string', 'tauri.conf.json 的 app.security.csp 必须是字符串');

  /** @type {Map<string, string>} */
  const directives = new Map();
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    const value = space === -1 ? '' : trimmed.slice(space + 1);
    directives.set(name, value);
  }

  assert.ok(directives.has('script-src'), 'CSP 缺少 script-src');
  assert.ok(directives.has('style-src'), 'CSP 缺少 style-src');
  assert.ok(!directives.get('script-src')?.includes("'unsafe-inline'"), "script-src 含 'unsafe-inline'");
  assert.ok(!directives.get('style-src')?.includes("'unsafe-inline'"), "style-src 含 'unsafe-inline'");
});
