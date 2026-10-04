/** Collect native installers, require the complete release set, and publish only verified assets. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const CHECKSUMS = 'SHA256SUMS';

export const PACKAGES = {
  'windows-x64': { target: 'x86_64-pc-windows-msvc', bundles: ['msi', 'nsis'] },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', bundles: ['deb', 'rpm', 'appimage'] },
  'macos-x64': { target: 'x86_64-apple-darwin', bundles: ['dmg'] },
  'macos-arm64': { target: 'aarch64-apple-darwin', bundles: ['dmg'] },
};
const EXTENSIONS = { msi: '.msi', nsis: '.exe', deb: '.deb', rpm: '.rpm', appimage: '.AppImage', dmg: '.dmg' };

export function packageNames(version, id) {
  if (!VERSION.test(version)) throw new Error(`无效的产品版本：${version}`);
  if (!Object.hasOwn(PACKAGES, id)) throw new Error(`未知的打包目标：${id}`);
  return PACKAGES[id].bundles.map(
    (bundle) => `laPower_${version}_${id}${bundle === 'nsis' ? '_setup' : ''}${EXTENSIONS[bundle]}`,
  );
}

async function fingerprint(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`安装包必须是非空普通文件：${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}

export async function cleanBundles(id, root = ROOT) {
  if (!Object.hasOwn(PACKAGES, id)) throw new Error(`未知的打包目标：${id}`);
  // The target is selected from fixed triples, so this absolute path stays inside root/target/.
  const directory = join(resolve(root), 'target', PACKAGES[id].target, 'release/bundle');
  await rm(directory, { recursive: true, force: true });
}

export async function collectPackages(id, version, root = ROOT) {
  const names = packageNames(version, id);
  const { target, bundles } = PACKAGES[id];
  const sources = [];
  for (const [index, bundle] of bundles.entries()) {
    const dir = join(root, 'target', target, 'release/bundle', bundle);
    const files = (await readdir(dir)).filter((name) => name.endsWith(EXTENSIONS[bundle]));
    if (files.length !== 1) throw new Error(`${id}/${bundle} 应有一个安装包，实际为 ${files.length}`);
    const file = files[0];
    const encodedVersion = version.replaceAll('.', '\\.');
    if (!new RegExp(`(?:^|[_-])${encodedVersion}(?:[_-])`).test(file)) {
      throw new Error(`安装包版本与清单 ${version} 不一致：${file}`);
    }
    const source = join(dir, file);
    await fingerprint(source);
    sources.push({ source, name: names[index] });
  }
  const destination = join(root, 'dist/packages');
  await mkdir(destination, { recursive: true });
  for (const { source, name } of sources) await copyFile(source, join(destination, name));
  return names;
}

/** Exact filenames prevent missing platforms, stale versions, and unexpected files from being published. */
export async function verifyPackages(directory, version, { writeChecksums = false } = {}) {
  const expected = Object.keys(PACKAGES)
    .flatMap((id) => packageNames(version, id))
    .sort();
  const actual = (await readdir(directory)).filter((name) => name !== CHECKSUMS).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`发布必须包含七个指定安装包\n期望：${expected.join(', ')}\n实际：${actual.join(', ')}`);
  }
  const assets = [];
  for (const name of expected) assets.push({ name, ...(await fingerprint(join(directory, name))) });
  const checksums = assets.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join('');
  const checksumPath = join(directory, CHECKSUMS);
  if (writeChecksums) await writeFile(checksumPath, checksums);
  else if ((await readFile(checksumPath, 'utf8')) !== checksums) throw new Error('SHA256SUMS 与安装包内容不一致');
  assets.push({ name: CHECKSUMS, ...(await fingerprint(checksumPath)) });
  return assets;
}

const RELEASE_BODY = `下载与安装：
- Windows x64：MSI 或 NSIS setup.exe；当前未做证书签名。
- macOS 12+：Intel 选择 macos-x64，Apple Silicon 选择 macos-arm64。应用仅有 ad-hoc 签名，未做 Developer ID 签名或公证；首次打开可能需要在“系统设置 → 隐私与安全性”中允许运行。macOS 12 兼容性仍需实机验证。
- Linux x64：DEB、RPM 或 AppImage；AppImage 需赋予执行权限，访问仪表需按仓库 docs/DEVELOPMENT.md 配置 udev 规则。安装包不会自动修改设备权限。
- SHA256SUMS：包含七个安装包的 SHA-256 校验和。
`;

/** All network access is injectable so failure/retry/public-release guards can be tested offline. */
export async function publishRelease({
  directory,
  version,
  tag,
  repository,
  token,
  commit,
  apiUrl = 'https://api.github.com',
  request = fetch,
}) {
  if (!VERSION.test(version) || tag !== `v${version}`) throw new Error('版本 Tag 必须与产品版本一致');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token || !/^[a-f\d]{40}$/i.test(commit ?? '')) {
    throw new Error('发布需要 GITHUB_REPOSITORY、GITHUB_TOKEN 和 GITHUB_SHA');
  }
  const assets = await verifyPackages(directory, version);
  const endpoint = `${apiUrl.replace(/\/$/, '')}/repos/${repository}`;
  async function api(url, { method = 'GET', json, body, contentType = 'application/vnd.github+json' } = {}) {
    const response = await request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': json ? 'application/json' : contentType,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'laPower-release',
      },
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${new URL(url).pathname} 失败（${response.status}）`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function list(path) {
    const results = [];
    for (let page = 1; ; page++) {
      const batch = await api(`${endpoint}/${path}?per_page=100&page=${page}`);
      results.push(...batch);
      if (batch.length < 100) return results;
    }
  }
  // Listing includes drafts; tag lookup alone is insufficient for failed upload reruns.
  let release = (await list('releases')).find((item) => item.tag_name === tag);
  if (release && !release.draft) throw new Error(`${tag} 已公开发布，不自动覆盖`);
  if (!release) {
    release = await api(`${endpoint}/releases`, {
      method: 'POST',
      json: {
        tag_name: tag,
        target_commitish: commit,
        name: `laPower ${tag}`,
        body: RELEASE_BODY,
        draft: true,
        prerelease: false,
        generate_release_notes: true,
      },
    });
  }
  const releasePath = `releases/${release.id}`;
  const oldAssets = await list(`${releasePath}/assets`);
  const allowed = new Set(assets.map(({ name }) => name));
  if (oldAssets.some(({ name }) => !allowed.has(name))) throw new Error('草稿包含非本次发布附件，请先人工检查');
  // Recheck before replacing draft assets in case someone published it manually.
  if (!(await api(`${endpoint}/${releasePath}`)).draft) throw new Error(`${tag} 已公开发布，不自动覆盖`);
  for (const asset of oldAssets) await api(`${endpoint}/releases/assets/${asset.id}`, { method: 'DELETE' });
  const uploadUrl = release.upload_url.replace(/\{.*$/, '');
  for (const asset of assets) {
    const url = new URL(uploadUrl);
    url.searchParams.set('name', asset.name);
    await api(url.href, {
      method: 'POST',
      contentType: 'application/octet-stream',
      body: await readFile(join(directory, asset.name)),
    });
  }
  const uploaded = await list(`${releasePath}/assets`);
  if (
    uploaded.length !== assets.length ||
    assets.some(
      ({ name, size, sha256 }) =>
        !uploaded.some(
          (remote) =>
            remote.name === name &&
            remote.state === 'uploaded' &&
            remote.size === size &&
            remote.digest === `sha256:${sha256}`,
        ),
    )
  ) {
    throw new Error('远端附件数量、大小或 SHA-256 校验失败，Release 保持草稿');
  }
  const published = await api(`${endpoint}/${releasePath}`, {
    method: 'PATCH',
    json: { draft: false, prerelease: false, make_latest: 'true' },
  });
  if (published.draft || published.prerelease) throw new Error('GitHub 未将 Release 设为公开正式版本');
  return published.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
    const directory = join(ROOT, 'dist/packages');
    if (process.argv.length !== 3) throw new Error('用法：node scripts/release.mjs clean|collect|verify|publish');
    switch (process.argv[2]) {
      case 'clean':
        await cleanBundles(process.env.PACKAGE_ID);
        break;
      case 'collect':
        console.log((await collectPackages(process.env.PACKAGE_ID, version)).join('\n'));
        break;
      case 'verify':
        console.log((await verifyPackages(directory, version, { writeChecksums: true })).map((a) => a.name).join('\n'));
        break;
      case 'publish': {
        const url = await publishRelease({
          directory,
          version,
          tag: process.env.GITHUB_REF_NAME,
          repository: process.env.GITHUB_REPOSITORY,
          token: process.env.GITHUB_TOKEN,
          commit: process.env.GITHUB_SHA,
          apiUrl: process.env.GITHUB_API_URL,
        });
        console.log(`已公开发布：${url}`);
        if (process.env.GITHUB_STEP_SUMMARY) {
          await writeFile(process.env.GITHUB_STEP_SUMMARY, `已公开发布：[laPower v${version}](${url})\n`, {
            flag: 'a',
          });
        }
        break;
      }
      default:
        throw new Error('用法：node scripts/release.mjs clean|collect|verify|publish');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
