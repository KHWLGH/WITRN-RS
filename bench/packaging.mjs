/**
 * 打包形状测量。
 *
 * bench/core 量的是算法，bench/ui-runner 量的是渲染；这里量的是"发货了什么、要取回几次"。
 * 它是本目录里唯一一个确定性、零噪声、因此可以直接给 CI 当硬门禁的测量台：没有计时，
 * 所以不需要基线，也不需要互证轮次。
 *
 *   node bench/packaging.mjs            报告 + 断言
 *   node bench/packaging.mjs --json     只吐 JSON（给 CI 存档）
 *
 * 存在的主要理由是新出现的孤儿资产会被抓住。frontendDist（现在是 `out/`）整个目录被
 * tauri-codegen 的 WalkDir 递归内嵌进二进制，所以"没人引用的文件"不是洁癖问题，是白占体积：
 * src/assets/codicon.ttf（123,192 字节）就是这么混进去的——没有任何 @font-face 引用它，
 * 唯一提到 "codicon" 的地方是 src/ui/menu.js 里一条永远匹配不上的字符串剥离。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, ROOT, saveJson } from './common.mjs';

const SRC = resolve(ROOT, 'src');
const TEXT_EXT = /\.(html|css|js|mjs|json|svg)$/i;

/** Files with no referrer. Every entry here is deliberate; a NEW orphan fails the run. */
const EXPECTED_ORPHANS = [
  // Type declarations for `npm run typecheck`. Never loaded at runtime, and now explicitly kept
  // out of out/ by build-dist.mjs — the neverShippable assertion below is what proves that stays true.
  'global.d.ts',
];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out.sort();
}

const rel = (p) => relative(SRC, p).replaceAll('\\', '/');

/** Every path index.html loads directly: that request count is the first-frame cost. */
function blockingRequests(html) {
  const stylesheets = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/g)];
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)];
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((m) => m[1].trim());
  const preloads = [...html.matchAll(/<link\b[^>]*rel=["']preload["'][^>]*>/g)];
  return {
    stylesheets: stylesheets.length,
    scripts: scripts.length,
    scriptSrcs: scripts.map((m) => m[1]),
    // CSP is style-src 'self'; an inline style attribute or <style> block is a regression
    // that the CSP test does not catch (it only asserts the absence of 'unsafe-inline').
    inlineScripts: inline.length,
    preloads: preloads.length,
  };
}

async function main() {
  const config = options(process.argv.slice(2), { json: false, output: '' });
  const files = await walk(SRC);
  const texts = new Map();
  const bytes = [];
  for (const path of files) {
    const info = await stat(path);
    bytes.push({ path: rel(path), bytes: info.size });
    if (TEXT_EXT.test(path)) texts.set(rel(path), await readFile(path, 'utf8'));
  }
  const totalBytes = bytes.reduce((sum, f) => sum + f.bytes, 0);

  const index = texts.get('index.html');
  assert.ok(index, 'src/index.html 不存在，frontendDist 会是空的');
  const requests = blockingRequests(index);

  // Referenced = its path, or its basename, appears in some OTHER text file. The basename arm
  // is what lets `url(flame.svg)` count as referencing assets/flame.svg. Deliberately
  // one-directional: a loose match only means a candidate goes unreported, it can never fail
  // the build over a name assembled at runtime.
  const refersTo = (path, text) => text.includes(path) || text.includes(path.slice(path.lastIndexOf('/') + 1));
  const unreferenced = (path) =>
    path !== 'index.html' &&
    !refersTo(path, index) &&
    ![...texts.entries()].some(([other, text]) => other !== path && refersTo(path, text));
  const allOrphans = bytes
    .map((f) => f.path)
    .filter(unreferenced)
    .sort();

  // Two different defects, and lumping them hides both:
  //  - tracked + unreferenced  = dead weight shipped to every user;
  //  - in frontendDist + not tracked = tauri-codegen embeds it anyway, so THIS binary is not the
  //    binary a clean checkout produces.
  // The second question is asked of frontendDist, not of src/: they diverged once the build started
  // producing out/ (src/.playwright-cli and src/global.d.ts are on disk and mirrored, or were, while
  // app.bundle.css is in out/ and exists in src/ nowhere).
  const tracked = new Set(
    execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^src\//, '')),
  );
  const deadWeight = allOrphans.filter((p) => tracked.has(p) && !EXPECTED_ORPHANS.includes(p));
  const srcSet = new Set(bytes.map((f) => f.path));
  const distRel = JSON.parse(await readFile(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).build.frontendDist;
  const dist = resolve(ROOT, 'src-tauri', distRel);
  let distFiles = null;
  try {
    distFiles = (await walk(dist)).map((p) => relative(dist, p).replaceAll('\\', '/'));
  } catch {
    distFiles = null;
  }
  const distSummary = distFiles
    ? {
        dir: distRel,
        files: distFiles.length,
        // Generated by the build step, expected: the CSS bundle.
        generated: distFiles.filter((p) => !srcSet.has(p)).sort(),
        // Mirrored from src/ but never committed => binary not reproducible from a clean checkout.
        untrackedEmbedded: distFiles.filter((p) => srcSet.has(p) && !tracked.has(p)).sort(),
        // Neither loaded nor declared: pure bytes in everyone's installer.
        neverShippable: distFiles.filter((p) => p.startsWith('.') || p.endsWith('.d.ts')).sort(),
      }
    : { dir: distRel, missing: true };

  const fontFaces = [...texts.entries()].flatMap(([path, text]) => [...text.matchAll(/@font-face\b/g)].map(() => path));
  const urlRefs = [...texts.entries()].flatMap(([from, text]) =>
    [...text.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g)]
      .map((m) => m[2])
      // data: URIs cost no request, which is the whole thing being counted here.
      .filter((target) => !target.startsWith('data:'))
      .map((target) => ({ from, target })),
  );
  const externalBytes = bytes
    .filter((f) => f.bytes > 64 * 1024)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);

  // Release image size, if a build exists. Reported, never asserted: it belongs to the
  // before/after table in the CHANGELOG, not to a gate that must pass on a clean checkout.
  let releaseImage = null;
  try {
    const info = await stat(resolve(ROOT, 'target/release/witrn-rs.exe'));
    releaseImage = { bytes: info.size, mtime: info.mtime.toISOString() };
  } catch {}

  const report = {
    schema: 'witrn-packaging-v1',
    layer: 'shipped shape; deterministic, no timing',
    // Read, never assume: this is what tauri-codegen will WalkDir over.
    frontendDist: distSummary,
    files: bytes.length,
    totalBytes,
    requests,
    fontFaces: fontFaces.length,
    cssUrlRequests: urlRefs.length,
    allOrphans,
    deadWeight,
    externalBytes,
    releaseImage,
    embeddedAssetCandidates: distFiles ? distFiles.length : null,
  };

  // Report before asserting: when this fails, the numbers on screen are the thing you need.
  if (config.output) await saveJson(config.output, report);
  if (config.json) console.log(JSON.stringify(report));
  else {
    console.log(
      `src/: ${report.files} 个文件, ${(totalBytes / 1024).toFixed(1)} KiB 未压缩` +
        `（内嵌时 tauri-codegen 逐个 brotli，所以这不等于二进制里的增量）`,
    );
    console.log(
      `首帧取回: ${requests.stylesheets} 个阻塞样式表 + ${requests.scripts} 个 <script> ` +
        `+ ${report.cssUrlRequests} 个 CSS url()（每次都过一次消息循环）`,
    );
    console.log(
      `@font-face: ${report.fontFaces}, 内联 <script>: ${requests.inlineScripts}, ` +
        `无人引用但已跟踪: ${deadWeight.join(', ') || '无'}`,
    );
    console.log(
      distFiles
        ? `${distRel}/: ${distFiles.length} 个文件会被内嵌；构建产出 ${distSummary.generated.join(', ') || '无'}；` +
            `未跟踪却被内嵌（干净检出复现不出这个二进制）: ${distSummary.untrackedEmbedded.join(', ') || '无'}；` +
            `本不该进包: ${distSummary.neverShippable.join(', ') || '无'}`
        : `${distRel}/ 不存在（跑 npm run build），因此跳过内嵌集合检查`,
    );
    if (releaseImage)
      console.log(
        `target/release/witrn-rs.exe: ${(releaseImage.bytes / 1048576).toFixed(2)} MiB (${releaseImage.mtime})`,
      );
    else console.log('target/release/witrn-rs.exe: 未构建（跑一次 cargo build --release 再来看镜像大小）');
    for (const f of externalBytes) console.log(`  ${(f.bytes / 1024).toFixed(1).padStart(8)} KiB  ${f.path}`);
  }

  assert.deepEqual(
    deadWeight,
    [],
    `被跟踪、没人引用、但仍会被内嵌进二进制：${deadWeight.join(', ')}。` +
      `要么接上引用，要么删掉，要么在 EXPECTED_ORPHANS 里写清理由。`,
  );
  assert.equal(requests.inlineScripts, 0, 'index.html 不允许内联 <script>（CSP script-src 是本仓库的边界）');
  // A missing frontendDist used to make this script print "跳过内嵌集合检查" and exit 0 -- the worst
  // possible shape for a gate: the two assertions that catch untracked and non-shippable embedded
  // files were silently unreachable, and the clean checkout (where out/ does not exist yet) is
  // exactly where that happened. Cargo fails in the same situation, so this should too.
  assert.ok(
    distFiles,
    `${distRel} 不存在，而它就是 frontendDist：内嵌集合根本没被检查过。先跑 npm run build（cargo 在这里同样会失败）。`,
  );
  if (distFiles) {
    assert.deepEqual(
      distSummary.neverShippable,
      [],
      `不该发货的文件被内嵌进二进制：${distSummary.neverShippable.join(', ')}。` +
        `.gitignore 拦不住它 —— tauri-codegen 按文件系统走 frontendDist，只能在 build-dist 的 mirror 里排除。`,
    );
    assert.deepEqual(
      distSummary.untrackedEmbedded,
      [],
      `这些文件在 ${distRel}/ 里、会被内嵌，但没有被 git 跟踪：${distSummary.untrackedEmbedded.join(', ')}。` +
        `于是这个二进制无法由干净检出复现。要么提交，要么删掉。`,
    );
  }
  if (!config.json)
    console.log(
      `断言通过：${allOrphans.length} 个无引用文件全部在允许清单内，0 个内联 script` +
        (distFiles ? `，${distFiles.length} 个内嵌文件全部已跟踪且非声明文件` : ''),
    );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

export { main };
