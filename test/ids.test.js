import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ID 契约测试：JS 与 index.html 之间靠 DOM id 交换控件（无框架、命令式更新），
 * 结构重排时最容易"移丢"某个 id。这里从 JS 源码提取所有 getElementById 字面量，
 * 断言每个 id 在 index.html 中恰好出现一次；并检查 HTML 内无重复 id。
 */

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 运行时由 JS 创建、不在静态 HTML 里的 id。 */
const RUNTIME_CREATED = new Set([
  'export-no-temp',
  'export-with-temp',
  'overflow-export-no-temp',
  'overflow-export-with-temp',
  'overflow-import',
  'overflow-clear',
]);

/** 动态拼接（模板字符串 / 配置数组）无法被字面量扫描捕获的契约 id。 */
const DYNAMIC_CONTRACT_IDS = [
  'show-voltage',
  'show-current',
  'show-power',
  'show-temp',
  'opacity-voltage',
  'opacity-current',
  'opacity-power',
  'opacity-temp',
  'view-monitor',
  'view-pd',
  'view-settings',
];

/** @param {string} dir @returns {string[]} */
function listJsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'assets') continue;
      files.push(...listJsFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function collectContractIds() {
  const ids = new Set(DYNAMIC_CONTRACT_IDS);
  for (const file of listJsFiles(srcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
      // 模板字符串（`view-${id}` 等）不是字面量，由 DYNAMIC_CONTRACT_IDS 覆盖
      if (!match[1].includes('${')) ids.add(match[1]);
    }
  }
  for (const id of RUNTIME_CREATED) ids.delete(id);
  return ids;
}

const html = readFileSync(path.join(srcDir, 'index.html'), 'utf8');

test('every JS-referenced id exists exactly once in index.html', () => {
  const missing = [];
  const duplicated = [];
  for (const id of collectContractIds()) {
    const count = html.split(`id="${id}"`).length - 1;
    if (count === 0) missing.push(id);
    else if (count > 1) duplicated.push(id);
  }
  assert.deepEqual(missing, [], `index.html 缺少这些契约 id: ${missing.join(', ')}`);
  assert.deepEqual(duplicated, [], `index.html 重复定义这些 id: ${duplicated.join(', ')}`);
});

test('index.html has no duplicate ids at all', () => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], `重复 id: ${dupes.join(', ')}`);
});
