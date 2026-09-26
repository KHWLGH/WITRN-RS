// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 文档命令契约测试。
 * docs/DEVELOPMENT.md 里写着"跑这个就能量到那个"，而这些命令行是文档作者手抄的：改了一个
 * `options()` 的键名、删掉一个脚本、把一个 npm script 改名，文档不会有任何反应，读者会在
 * 第一步就撞上 `Unknown option`。仓库已经用 version-sync.test.js 消灭了"版本号写三处"的分叉，
 * 这里是同一类问题的另一半 —— 可执行说明只有一个真相来源（代码），文档是它的投影。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const docs = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];
const DOC_TEXT = docs.map((f) => ({ file: f, text: read(f).replace(/\\\r?\n/g, ' ') }));

/** kebab-case 命令行 -> options() 里的 camelCase 键，规则与 bench/common.mjs 一致。 */
const camel = (flag) => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** 从 bench 脚本里静态取出 options(argv, {...}) 的默认键集合。 */
function optionKeys(rel) {
  const src = read(rel);
  const start = src.search(/options\(\s*[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*,\s*\{/, 's');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end);
  // 只取顶层键：先量出第一个键的缩进，再按同一缩进取。用固定两空格会整批漏掉（缩进是四格时），
  // 那会让这个检查变成永远通过的空跑。
  const firstKey = body.match(/^([ \t]+)([A-Za-z][A-Za-z0-9_]*)\s*:/m);
  if (!firstKey) return new Set();
  const indent = firstKey[1];
  return new Set(
    [...body.matchAll(new RegExp(`^${indent.replace(/ /g, '\\ ')}([A-Za-z][A-Za-z0-9_]*)\\s*:`, 'gm'))].map(
      (m) => m[1],
    ),
  );
}

const COMMAND_RE =
  /node (?:bench|scripts)\/[A-Za-z0-9_./-]+\.mjs(?:[ \t]+(?:--[a-z][a-z-]*(?:=[^\s`,)]*)?|[A-Za-z0-9_.:/-]+))*/g;

/** @type {{file:string, script:string, flags:string[]}[]} */
const documented = [];
for (const { file, text } of DOC_TEXT) {
  for (const match of text.matchAll(COMMAND_RE)) {
    const parts = match[0].split(/\s+/);
    const script = parts[1];
    const flags = parts.slice(2).filter((p) => p.startsWith('--'));
    documented.push({ file, script, flags });
  }
}

/**
 * CI 自己写的命令也必须受同一条契约约束：workflow 里的 `node bench/x.mjs --flag` 同样是手抄的，
 * 而它比文档更危险 —— 文档写错人会在本地撞上，workflow 写错只会在 PR 上红，或者更糟：那一步
 * 是 report-only，于是静默地什么都不检查。
 */
test('workflow 里写的命令同样指向真实脚本与真实 flag', () => {
  const dir = '.github/workflows';
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 2, `${dir} 里只找到 ${files.length} 个 yml，路径或扩展名不对`);
  const commands = [];
  for (const f of files) {
    // `run: |` 里的反斜杠续行会把一条命令拆成两行，先接回来（YAML 块标量里的内容对正则就是文本）。
    const text = read(join(dir, f)).replace(/\\\r?\n[ \t]*/g, ' ');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(
        /(?:node (?:bench|scripts)\/[A-Za-z0-9_./-]+\.mjs(?:[ \t]+[^\s#|&;]+)*|npm run [a-zA-Z][\w:-]*)/,
      );
      if (m) commands.push({ file: f, raw: m[0] });
    }
  }
  assert.ok(commands.length >= 10, `只抓到 ${commands.length} 条 workflow 命令，解析器不可信`);
  const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts));
  const cache = new Map();
  const problems = [];
  for (const { file, raw } of commands) {
    if (raw.startsWith('npm run')) {
      const name = raw.slice('npm run '.length);
      if (!scripts.has(name)) problems.push(`${file}: npm run ${name} 不存在`);
      continue;
    }
    const parts = raw.split(/\s+/);
    const script = parts[1];
    if (!existsSync(join(root, script))) {
      problems.push(`${file}: 不存在的脚本 ${script}`);
      continue;
    }
    for (const token of parts.slice(2)) {
      // `npm run x -- --csv` 的分隔符 `--` 不是 flag；带 $()/引号的值也不是。
      if (token.length <= 2 || !token.startsWith('--') || /[$("']/.test(token)) continue;
      const flag = token.slice(2).split('=')[0];
      if (!script.startsWith('bench/')) {
        if (!read(script).includes(`--${flag}`)) problems.push(`${file}: ${script} 不认识 --${flag}`);
        continue;
      }
      if (!cache.has(script)) cache.set(script, optionKeys(script));
      const keys = cache.get(script);
      if (!keys) {
        problems.push(`${file}: ${script} 里没有 options() 字面量，无法校验 --${flag}`);
        continue;
      }
      if (keys.size < 3) problems.push(`${file}: ${script} 的 options() 只解析出 ${keys.size} 个键，解析器不可信`);
      if (!keys.has(camel(flag))) problems.push(`${file}: ${script} 没有 --${flag}（可选键：${[...keys].join(', ')}）`);
    }
  }
  assert.deepEqual(problems, []);
});

test('文档里的 node 命令都指向真实存在的脚本', () => {
  assert.ok(documented.length >= 8, `只抓到 ${documented.length} 条文档命令，正则可能已经失效`);
  const missing = documented.filter(({ script }) => !existsSync(join(root, script)));
  assert.deepEqual([...new Set(missing.map((m) => `${m.file}: ${m.script}`))], [], '文档写了不存在的脚本');
});

test('文档写的每一个 flag 都在脚本的 options() 默认值里', () => {
  const cache = new Map();
  const problems = [];
  for (const { file, script, flags } of documented) {
    for (const raw of flags) {
      const flag = raw.split('=')[0].slice(2);
      if (!script.startsWith('bench/')) {
        if (!read(script).includes(`--${flag}`)) problems.push(`${file}: ${script} 不认识 --${flag}`);
        continue;
      }
      if (!cache.has(script)) cache.set(script, optionKeys(script));
      const keys = cache.get(script);
      if (!keys) {
        problems.push(`${file}: ${script} 里没有 options() 字面量，无法校验 --${flag}`);
        continue;
      }
      // 解析失败会给出空集合，那样每条 flag 都"不存在"；但反过来，一个只解析出一两个键的
      // 解析器同样是坏仪器，所以这里直接拒绝可疑的窄集合。
      if (keys.size < 3) problems.push(`${file}: ${script} 的 options() 只解析出 ${keys.size} 个键，解析器不可信`);
      if (!keys.has(camel(flag))) problems.push(`${file}: ${script} 没有 --${flag}（可选键：${[...keys].join(', ')}）`);
    }
  }
  assert.deepEqual(problems, []);
});

test('npm run 提到的脚本都存在', () => {
  const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts));
  const mentioned = new Set();
  for (const { text } of DOC_TEXT) {
    for (const m of text.matchAll(/npm run ([a-zA-Z][\w:-]*)/g)) {
      // 文档里有意写了反例（"构建命令是 cargo tauri dev，不是 npm run tauri dev"、"有 npm run
      // build 但没有 npm run dev"），那类提法恰恰在说明脚本不存在，不能算违约。
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (/不是|没有|而非|并非|不是\b/.test(before)) continue;
      mentioned.add(m[1]);
    }
  }
  const unknown = [...mentioned].filter((name) => !scripts.has(name));
  assert.deepEqual(unknown, [], `文档写了不存在的 npm script：${unknown.join(', ')}`);
});

test('每个可运行的测量台入口都在文档里出现', () => {
  // 只要求入口脚本（自己带 main 守卫的那些）。common.mjs / fixtures.mjs 是被 import 的库，
  // 用户不会去跑它们，写进文档反而误导。
  const scripts = readdirSync(join(root, 'bench'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `bench/${f}`)
    .filter((rel) => read(rel).includes('pathToFileURL(process.argv[1]'));
  const allText = DOC_TEXT.map((d) => d.text).join('\n');
  const undocumented = scripts.filter((s) => !allText.includes(s));
  assert.deepEqual(undocumented, [], '新增 bench 入口脚本必须同时写进文档，否则没人知道它存在');
});

test('文档正文里以路径形式出现的文件都存在', () => {
  // 只收"看起来明确是仓库内路径"的反引号片段：含斜杠、有扩展名、不含通配/占位符。
  const isPath = (s) =>
    /^[A-Za-z0-9_.-](?:[A-Za-z0-9_.@:/-]*\/)[A-Za-z0-9_.@/-]*$/.test(s) &&
    /\.[A-Za-z0-9]{1,6}$/.test(s) &&
    !/[<>*]/.test(s) &&
    !s.startsWith('http') &&
    !s.includes('://');
  const problems = [];
  for (const { file, text } of DOC_TEXT) {
    for (const m of text.matchAll(/`([^`\s]+)`/g)) {
      const rel = m[1].replace(/^\.\//, '');
      if (!isPath(rel)) continue;
      if (/^(src|bench|scripts|docs|out)\//.test(rel) || rel.startsWith('src-tauri/')) {
        if (!existsSync(join(root, rel)) && !existsSync(join(root, 'src-tauri', rel))) {
          problems.push(`${file}: \`${rel}\` 不存在`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});
