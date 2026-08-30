import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 版本契约测试：同一个版本号写在三处（npm / Cargo 工作区 / Tauri 配置），
 * 发版时靠手动同步，漏改一处不会有任何报错——装出来的包和源码对不上，
 * 也不会有任何构建或测试失败提示。这里断言三处一致，并断言三个成员 crate
 * 仍然 `version.workspace = true`，否则版本号会变成第四、第五个真相来源。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel @returns {string} */
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** 工作区成员，版本号必须继承而不是各写各的。 */
const MEMBER_CRATES = ['src-tauri', 'crates/usbpd-parser', 'crates/witrn-hid'];

/**
 * 取 `[workspace.package]` 段内的 version。
 * 按段切开而不是全文匹配，避免命中 `[workspace.dependencies]` 里依赖的版本号。
 * @returns {string}
 */
function workspaceVersion() {
  const section = read('Cargo.toml')
    .split(/^\[/m)
    .find((chunk) => chunk.startsWith('workspace.package]'));
  assert.ok(section, 'Cargo.toml 缺少 [workspace.package] 段');
  const match = section.match(/^\s*version\s*=\s*"([^"]+)"/m);
  assert.ok(match, 'Cargo.toml 的 [workspace.package] 缺少 version');
  return match[1];
}

test('version is identical across package.json, Cargo.toml and tauri.conf.json', () => {
  const versions = {
    'package.json': JSON.parse(read('package.json')).version,
    'Cargo.toml': workspaceVersion(),
    'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  };

  const distinct = [...new Set(Object.values(versions))];
  assert.equal(distinct.length, 1, `版本号三处必须一致，实际为 ${JSON.stringify(versions, null, 2)}`);
});

test('version is a plain semver triple', () => {
  const version = workspaceVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/, `版本号应为 X.Y.Z，实际为 "${version}"`);
});

test('member crates inherit the workspace version', () => {
  const offenders = MEMBER_CRATES.filter(
    (crate) => !/^\s*version\.workspace\s*=\s*true/m.test(read(`${crate}/Cargo.toml`)),
  );
  assert.deepEqual(
    offenders,
    [],
    `这些 crate 没有继承工作区版本（应写 version.workspace = true）: ${offenders.join(', ')}`,
  );
});

test('tauri macOS private API feature stays aligned with tauri.conf.json', () => {
  const tauriCargo = read('src-tauri/Cargo.toml');
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
  const hasMacosPrivateApiFeature = /tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"macos-private-api"/s.test(tauriCargo);
  const macosPrivateApiEnabledInConfig = tauriConfig?.app?.macOSPrivateApi === true;
  assert.equal(
    hasMacosPrivateApiFeature,
    macosPrivateApiEnabledInConfig,
    '若 tauri 依赖启用 macos-private-api，需在 tauri.conf.json 的 app.macosPrivateApi 同步开启（反之亦然）',
  );
});
