import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setVersion } from '../scripts/set-version.mjs';

/**
 * 版本契约测试：同一个版本号写在三处（npm / Cargo 工作区 / Tauri 配置），
 * 使用统一命令同步清单和锁文件。这里检查版本一致、四个成员 crate 继承工作区，
 * 并验证命令只更新产品版本，保留第三方依赖和历史更新日志。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel @returns {string} */
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** 工作区成员，版本号必须继承而不是各写各的。 */
const MEMBER_CRATES = ['src-tauri', 'crates/usbpd-parser', 'crates/witrn-hid', 'crates/km003c'];

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

test('version is identical across manifests and lockfiles', () => {
  const npmLock = JSON.parse(read('package-lock.json'));
  const versions = {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': npmLock.version,
    'package-lock.json root package': npmLock.packages[''].version,
    'Cargo.toml': workspaceVersion(),
    'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  };
  const packages = read('Cargo.lock').split(/^\[\[package\]\]/m);
  for (const crate of MEMBER_CRATES) {
    const name = read(`${crate}/Cargo.toml`).match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const entries = packages.filter(
      (pkg) => pkg.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === name && !/^source\s*=/m.test(pkg),
    );
    assert.equal(entries.length, 1, `Cargo.lock 必须有一个工作区包 ${name}`);
    versions[`Cargo.lock ${name}`] = entries[0].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  }

  const distinct = [...new Set(Object.values(versions))];
  assert.equal(distinct.length, 1, `版本号必须一致，实际为 ${JSON.stringify(versions, null, 2)}`);
});

test('version is a plain semver triple', () => {
  const version = workspaceVersion();
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, `版本号应为 X.Y.Z，实际为 "${version}"`);
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

const VERSION_FILES = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'src-tauri/tauri.conf.json'];

function versionFixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lapower-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of [...VERSION_FILES, ...MEMBER_CRATES.map((crate) => `${crate}/Cargo.toml`), 'CHANGELOG.md']) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), read(rel));
  }
  return dir;
}

test('unified version command updates product versions without changing dependencies or history', (t) => {
  const dir = versionFixture(t);
  const target = workspaceVersion() === '3.4.5' ? '3.4.6' : '3.4.5';
  const changed = setVersion(target, dir);
  assert.deepEqual(changed.toSorted(), VERSION_FILES.toSorted());
  const readUpdated = (rel) => readFileSync(path.join(dir, rel), 'utf8');
  for (const rel of ['package.json', 'src-tauri/tauri.conf.json']) {
    assert.deepEqual(JSON.parse(readUpdated(rel)), { ...JSON.parse(read(rel)), version: target });
  }
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = target;
  lock.packages[''].version = target;
  assert.deepEqual(JSON.parse(readUpdated('package-lock.json')), lock);
  assert.equal(
    readUpdated('Cargo.toml'),
    read('Cargo.toml').replace(/(\[workspace\.package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${target}"`),
  );
  const originalPackages = read('Cargo.lock').split(/^\[\[package\]\]/m);
  const updatedPackages = readUpdated('Cargo.lock').split(/^\[\[package\]\]/m);
  const names = MEMBER_CRATES.map((crate) => read(`${crate}/Cargo.toml`).match(/^name\s*=\s*"([^"]+)"/m)[1]);
  assert.equal(updatedPackages.length, originalPackages.length);
  for (let i = 0; i < originalPackages.length; i++) {
    const pkg = originalPackages[i];
    const isMember = names.includes(pkg.match(/^name\s*=\s*"([^"]+)"/m)?.[1]) && !/^source\s*=/m.test(pkg);
    assert.equal(updatedPackages[i], isMember ? pkg.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${target}"`) : pkg);
  }
  assert.equal(readUpdated('CHANGELOG.md'), read('CHANGELOG.md'));
  assert.deepEqual(setVersion(target, dir), [], '重复设置应不写文件');
});

test('unified version command rejects invalid input before writing files', (t) => {
  const dir = versionFixture(t);
  for (const version of ['', 'v0.2.2', '0.2', '01.2.3', '0.2.2-beta.1', '0.2.2\n', '0.2.2; echo bad']) {
    assert.throws(() => setVersion(version, dir), /版本号必须/);
  }
  for (const rel of VERSION_FILES) assert.equal(readFileSync(path.join(dir, rel), 'utf8'), read(rel));
});

test('unified version command validates all manifests and lockfiles before writing', (t) => {
  const dir = versionFixture(t);
  const cargoLock = path.join(dir, 'Cargo.lock');
  writeFileSync(cargoLock, read('Cargo.lock').replace(/^name = "witrn-hid"$/m, 'name = "missing-member"'));
  const snapshots = VERSION_FILES.map((rel) => readFileSync(path.join(dir, rel), 'utf8'));
  assert.throws(() => setVersion('3.4.5', dir), /Cargo.lock 缺少工作区包/);
  for (const [i, rel] of VERSION_FILES.entries()) {
    assert.equal(readFileSync(path.join(dir, rel), 'utf8'), snapshots[i]);
  }
});

/**
 * tauri-build 优先检查 [dependencies] 的 tauri 声明，不合并 target 依赖的
 * features。主配置及 macOS overlay 都必须与该声明一致，才能通过各平台校验。
 */
test('macos-private-api Cargo feature matches tauri.conf.json', () => {
  const defaultDependencies = read('src-tauri/Cargo.toml')
    .split(/^\[/m)
    .find((chunk) => chunk.startsWith('dependencies]'));
  assert.ok(defaultDependencies, 'src-tauri/Cargo.toml 缺少 [dependencies] 段');

  const hasMacosPrivateApiFeature = /tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"macos-private-api"/s.test(
    defaultDependencies,
  );
  const baseApp = JSON.parse(read('src-tauri/tauri.conf.json')).app;
  for (const config of ['tauri.conf.json', 'tauri.macos.conf.json']) {
    const app = { ...baseApp, ...JSON.parse(read(`src-tauri/${config}`)).app };
    assert.equal(
      hasMacosPrivateApiFeature,
      app.macOSPrivateApi === true,
      `${config} 的 app.macOSPrivateApi 必须与 [dependencies] tauri 的 macos-private-api feature 一致`,
    );
  }
});
