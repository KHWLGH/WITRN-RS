import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargoToml = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');

test('macos-private-api is only enabled for macOS target', () => {
  const defaultDependencies = cargoToml
    .split(/^\[/m)
    .find((chunk) => chunk.startsWith('dependencies]'));
  assert.ok(defaultDependencies, 'src-tauri/Cargo.toml 缺少 [dependencies] 段');
  assert.ok(
    !/macos-private-api/.test(defaultDependencies),
    '不应在默认 [dependencies] 下全局启用 macos-private-api',
  );

  const macosDependencies = cargoToml
    .split(/^\[/m)
    .find((chunk) => chunk.startsWith(`target.'cfg(target_os = "macos")'.dependencies]`));
  assert.ok(macosDependencies, 'src-tauri/Cargo.toml 缺少 macOS target 依赖段');
  assert.match(
    macosDependencies,
    /tauri\s*=\s*\{[^}]*macos-private-api[^}]*\}/,
    'macOS target 依赖段必须为 tauri 启用 macos-private-api',
  );
});
