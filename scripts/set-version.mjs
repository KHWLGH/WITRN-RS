import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function replaceOnce(text, pattern, replacement, label) {
  if ([...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length !== 1) {
    throw new Error(`${label} 必须恰好有一个版本字段`);
  }
  return text.replace(pattern, replacement);
}

/** Only edit version values; keep formatting and dependency resolutions intact. */
export function setVersion(version, root = ROOT) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error('版本号必须为 X.Y.Z（非负整数，不含前导零），例如 0.2.2');
  }

  const files = new Map();
  const read = (rel) => {
    const text = readFileSync(resolve(root, rel), 'utf8');
    files.set(rel, { before: text, after: text });
    return text;
  };
  const update = (rel, after) => {
    files.get(rel).after = after;
  };

  for (const rel of ['package.json', 'src-tauri/tauri.conf.json']) {
    const text = read(rel);
    const manifest = JSON.parse(text);
    if (typeof manifest.version !== 'string') throw new Error(`${rel} 缺少 version`);
    const after = replaceOnce(text, /^( {2}"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`, rel);
    if (JSON.parse(after).version !== version) throw new Error(`${rel} 的 version 更新失败`);
    update(rel, after);
  }

  const npmLock = read('package-lock.json');
  const lock = JSON.parse(npmLock);
  if (typeof lock.version !== 'string' || typeof lock.packages?.['']?.version !== 'string') {
    throw new Error('package-lock.json 缺少根包版本，请先运行 npm install');
  }
  let npmAfter = replaceOnce(npmLock, /^( {2}"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`, 'npm 锁文件');
  npmAfter = replaceOnce(
    npmAfter,
    /("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*)"[^"]*"/,
    `$1"${version}"`,
    'npm 锁文件根包',
  );
  update('package-lock.json', npmAfter);

  const cargo = read('Cargo.toml');
  update(
    'Cargo.toml',
    replaceOnce(
      cargo,
      /(\[workspace\.package\](?:(?!^\[)[\s\S])*?^version[ \t]*=[ \t]*)"[^"]*"/m,
      `$1"${version}"`,
      'Cargo 工作区',
    ),
  );
  const workspace = cargo.match(/^\[workspace\]\s*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  const members = workspace?.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1].match(/"[^"]+"/g);
  if (!members?.length) throw new Error('Cargo.toml 缺少显式的 workspace members 列表');
  const names = members.map((member) => {
    const rel = `${JSON.parse(member)}/Cargo.toml`;
    const manifest = readFileSync(resolve(root, rel), 'utf8');
    const pkg = manifest.match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
    const name = pkg?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !/^version\.workspace\s*=\s*true\s*$/m.test(pkg)) {
      throw new Error(`${rel} 必须声明包名并使用 version.workspace = true`);
    }
    return name;
  });

  const cargoLock = read('Cargo.lock');
  const seen = new Set();
  const cargoAfter = cargoLock.replace(/^\[\[package\]\]\r?\n[\s\S]*?(?=^\[\[package\]\]|(?![\s\S]))/gm, (pkg) => {
    const name = pkg.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (!names.includes(name) || /^source\s*=/m.test(pkg)) return pkg;
    if (seen.has(name)) throw new Error(`Cargo.lock 中工作区包 ${name} 重复`);
    seen.add(name);
    return replaceOnce(pkg, /^(version\s*=\s*)"[^"]*"/m, `$1"${version}"`, `Cargo.lock: ${name}`);
  });
  const missing = names.filter((name) => !seen.has(name));
  if (missing.length) throw new Error(`Cargo.lock 缺少工作区包：${missing.join(', ')}，请先运行 cargo metadata`);
  update('Cargo.lock', cargoAfter);

  // Validate every input before writing, so invalid versions/manifests leave files untouched.
  const changed = [];
  for (const [rel, { before, after }] of files) {
    if (before === after) continue;
    writeFileSync(resolve(root, rel), after);
    changed.push(rel);
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run version:set -- X.Y.Z');
    const changed = setVersion(process.argv[2]);
    console.log(
      `版本号已统一为 ${process.argv[2]}${changed.length ? `，更新：${changed.join(', ')}` : '（无需更改）'}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
