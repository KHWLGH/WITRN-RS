/**
 * Pre-release consistency check -- the part of "cut a release" that a machine can actually decide.
 *
 * Two things must agree before a tag means anything:
 *   1. the tag names the version that every manifest carries at that commit (four copies: npm,
 *      tauri.conf.json, the cargo workspace, plus the tag itself), and
 *   2. the hardware acceptance receipt describes code that the tag really ships, i.e. its commit is
 *      an ancestor of the tag. Otherwise the 100 Hz run validated a different build than the one
 *      users will download.
 *
 * Kept out of the workflow YAML on purpose: shell with nested quotes around `git show | node -e` is
 * unverifiable without pushing a commit, and this file can be run -- and is tested -- locally.
 *
 *   node scripts/check-release-tag.mjs --tag v0.2.2 [--receipt acceptance.json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { options } from '../bench/common.mjs';
import { checkReceipt, SCHEMA } from './verify-hardware-receipt.mjs';

const VERSION_SOURCES = [
  { path: 'package.json', label: 'npm', read: (text) => JSON.parse(text).version },
  { path: 'src-tauri/tauri.conf.json', label: 'tauri', read: (text) => JSON.parse(text).version },
  {
    path: 'Cargo.toml',
    label: 'cargo workspace',
    read: (text) => {
      const section = text.split(/^\[/m).find((chunk) => chunk.startsWith('workspace.package]'));
      const match = section?.match(/^\s*version\s*=\s*"([^"]+)"/m);
      if (!match) throw new Error('Cargo.toml 的 [workspace.package] 段里没有 version');
      return match[1];
    },
  },
];

// git's own "fatal: path ... exists on disk, but not in <tag>" goes to stderr; dropping it keeps one
// clear message per problem instead of two overlapping ones.
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** @param {string} tag @returns {{ok:boolean, problems:string[], rows:string[]}} */
export function checkTagVersions(tag) {
  const wanted = tag.replace(/^v/, '');
  const problems = [];
  const rows = [];
  for (const source of VERSION_SOURCES) {
    let text;
    try {
      text = git(['show', `${tag}:${source.path}`]);
    } catch (error) {
      problems.push(`${source.path}: 在 ${tag} 里读不出来（${String(error.message).split('\n')[0]}）`);
      continue;
    }
    let found;
    try {
      found = source.read(text);
    } catch (error) {
      problems.push(`${source.path}: ${error.message}`);
      continue;
    }
    rows.push(`${source.label.padEnd(16)} ${source.path} -> ${found}`);
    if (found !== wanted) problems.push(`${source.path} 在 ${tag} 处是 ${found}，tag 要的是 ${wanted}`);
  }
  return { ok: problems.length === 0, problems, rows };
}

/**
 * @param {string} tag
 * @param {any} receipt
 */
export function checkReceiptBelongsToTag(tag, receipt) {
  const problems = checkReceipt(receipt);
  if (receipt?.schema !== SCHEMA)
    return { problems: [...problems, `回执 schema 不是 ${SCHEMA}`], commit: null, tagCommit: null };
  const tagCommit = git(['rev-list', '-n', '1', tag]);
  const claimed = String(receipt.commit ?? '');
  if (!claimed)
    return { problems: [...problems, '回执没有 commit 字段，无法确定测的是哪次构建'], commit: null, tagCommit };
  let full;
  try {
    full = git(['rev-parse', '--verify', '--end-of-options', `${claimed}^{commit}`]);
  } catch {
    return { problems: [...problems, `回执里的 commit ${claimed} 在仓库里不存在`], commit: null, tagCommit };
  }
  const ancestor =
    full === tagCommit ||
    (() => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', full, tagCommit], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
  if (!ancestor)
    problems.push(
      `回执测的是 ${full.slice(0, 8)}，它不是 ${tag}(${tagCommit.slice(0, 8)}) 的祖先：验收的代码不在这次发版里`,
    );
  return { problems, commit: full, tagCommit };
}

const main = () => {
  const opts = options(process.argv.slice(2), { tag: '', receipt: '' });
  if (!opts.tag) throw new Error('用法: node scripts/check-release-tag.mjs --tag v0.2.2 [--receipt acceptance.json]');
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${opts.tag}`]);
  } catch {
    console.error(`::error::tag ${opts.tag} 在本仓库不存在`);
    process.exitCode = 1;
    return;
  }
  const versions = checkTagVersions(opts.tag);
  for (const row of versions.rows) console.log(`  ${row}`);
  const problems = [...versions.problems];
  if (opts.receipt) {
    const receipt = JSON.parse(readFileSync(opts.receipt, 'utf8'));
    const link = checkReceiptBelongsToTag(opts.tag, receipt);
    problems.push(...link.problems);
    if (link.commit && !problems.some((p) => p.includes('不是')))
      console.log(`  回执 commit ${link.commit.slice(0, 8)} 是 ${link.tagCommit.slice(0, 8)} 的祖先`);
  }
  if (problems.length) {
    console.error('::error::发版前置检查未通过：\n  - ' + problems.join('\n  - '));
    process.exitCode = 1;
    return;
  }
  console.log(`tag ${opts.tag} 的版本与清单一致${opts.receipt ? '，且验收回执归属于它' : ''}。`);
  console.log(
    '下一步仍是人工操作（本脚本刻意不做）：本地 cargo tauri build --bundles nsis、装包抽查、由人推 tag 建 Release。',
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
