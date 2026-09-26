/**
 * Build the shipped frontend into `out/`.
 *
 * Scope, and why: `bench/startup.mjs` measured 87 sub-resource fetches occupying ~246ms of the
 * ~305ms between webview context and appReady — about 2.8ms per request, because each one is a
 * round trip through the custom protocol. The cost is request COUNT, not bytes, so this step
 * collapses the render-blocking stylesheets (9 → 1) and leaves the rest of the shape intact.
 *
 * JS is copied verbatim. Not bundling it keeps three things that already exist: `tsc --noEmit`
 * typechecking the exact bytes that ship, `test/*.test.js` importing `src/` directly, and
 * `bench/ui-server.mjs --revision <sha>` serving historical code for A/B — the last only possible
 * on unbundled sources. `--bundle-js` is deliberately unimplemented: the fetch-count finding makes
 * it a decision to take with data, not a flag to flip.
 *
 *   node scripts/build-dist.mjs            dev: readable, unminified
 *   node scripts/build-dist.mjs --minify   release
 *
 * Layout note that dictates the design: the tree is mirrored into out/ BEFORE bundling and esbuild
 * runs entirely inside out/. Bundling from src/ into out/ resolves assets against the common
 * ancestor of the two directories, so esbuild writes `out/src/assets/...` and duplicates every
 * icon — 56 SVG files where there should be 28.
 *
 * Asserted, not trusted: no inline <script>/<style>, no `style=` attributes, no NEW data: URLs,
 * every index.html reference resolves to a real file, nothing escapes out/. CSP is
 * `script-src 'self'; style-src 'self'` and a blocked icon mask fails silently — blank buttons,
 * nothing in the console — so those regressions are invisible at runtime by construction.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const OUT = resolve(ROOT, 'out');
const BUNDLE = 'app.bundle.css';

const styleHrefs = (html) =>
  [
    ...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g),
    ...html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/g),
  ].map((m) => m[1]);

/** POSIX-style relative paths of every file under a directory. */
async function allFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await allFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

async function totalBytes(dir) {
  const all = await allFiles(dir);
  const stats = await Promise.all(all.map((rel) => stat(join(dir, rel))));
  return { count: all.length, bytes: stats.reduce((n, s) => n + s.size, 0) };
}

async function main() {
  const argv = process.argv.slice(2);
  const minify = argv.includes('--minify');
  for (const flag of argv) {
    if (flag === '--minify') continue;
    if (flag === '--bundle-js') throw new Error('--bundle-js 尚未实现：它现在是一个要用数据决定的选择，不是开关');
    throw new Error(`Unknown flag: ${flag}`);
  }

  const html = await readFile(join(SRC, 'index.html'), 'utf8');
  const hrefs = styleHrefs(html);
  if (!hrefs.length) throw new Error('index.html 里找不到任何样式表，合并步骤没有意义');
  const sheetPaths = hrefs.map((href) => {
    const rel = href.replace(/^\//, '');
    if (rel.startsWith('..')) throw new Error(`样式表路径越界：${href}`);
    return rel;
  });

  // 1. mirror src/ verbatim, so bundling never has to leave the outdir
  await rm(OUT, { recursive: true, force: true });
  // Skip what must not ship: dot-entries are tool scratch, and `*.d.ts` exists only for
  // `npm run typecheck`. Neither is stopped by .gitignore, because tauri-codegen walks frontendDist
  // on the filesystem at macro-expansion time — `.playwright-cli/page-…yml` reached a release build
  // this way, and so did global.d.ts until it was excluded here.
  const skipped = [];
  async function mirror(rel = '') {
    for (const entry of await readdir(join(SRC, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || entry.name.endsWith('.d.ts')) {
        skipped.push(child);
        continue;
      }
      if (entry.isDirectory()) {
        await mkdir(join(OUT, child), { recursive: true });
        await mirror(child);
      } else {
        await mkdir(dirname(join(OUT, child)), { recursive: true });
        await writeFile(join(OUT, child), await readFile(join(SRC, child)));
      }
    }
  }
  await mirror();
  if (skipped.length) console.log(`不复制进 out/ 的非发货条目: ${skipped.join(', ')}`);
  for (const rel of sheetPaths) await stat(join(OUT, rel)); // a missing linked sheet fails here

  // 2. one entry @importing in document order: the cascade stays exactly as the nine <link>s had it
  const entryRel = '__all-styles-entry.css';
  await writeFile(join(OUT, entryRel), `${sheetPaths.map((rel) => `@import "${rel}";`).join('\n')}\n`);

  const sourceDataUrls = (
    await Promise.all(sheetPaths.map((rel) => readFile(join(SRC, rel), 'utf8').catch(() => '')))
  ).reduce((n, css) => n + (css.match(/url\(\s*["']?data:/gi)?.length ?? 0), 0);

  const result = await build({
    entryPoints: [join(OUT, entryRel)],
    outfile: join(OUT, BUNDLE),
    absWorkingDir: OUT,
    bundle: true,
    minify,
    loader: { '.svg': 'file', '.png': 'file', '.woff2': 'file', '.ttf': 'file' },
    // Emitted asset names equal to their source names, so the mirrored originals are overwritten
    // in place instead of a second copy appearing alongside them. The overwrite is a byte-identical
    // no-op for the `file` loader; without this esbuild refuses to write onto its own input.
    assetNames: '[dir]/[name]',
    allowOverwrite: true,
    metafile: true,
    write: true,
    logLevel: 'warning',
  });

  // 3. the entry and the now-inlined sheets are dead weight
  for (const rel of [...sheetPaths, entryRel]) await rm(join(OUT, rel), { force: true });
  // Any @imported sheet that was not in index.html is inlined too but still mirrored; leaving them
  // would ship the same rules twice, so drop every remaining source stylesheet.
  for (const rel of (await allFiles(OUT)).filter((p) => p.endsWith('.css') && p !== BUNDLE && !p.startsWith('vendor/')))
    await rm(join(OUT, rel), { force: true });

  // 4. rewrite index.html onto the single bundle
  let outHtml = html;
  for (const href of hrefs) {
    const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    outHtml = outHtml.replace(new RegExp(`[ \\t]*<link\\b[^>]*href=["']${escaped}["'][^>]*>\\r?\\n?`, 'g'), '');
  }
  outHtml = outHtml.replace(/<\/head>/, `    <link rel="stylesheet" href="${BUNDLE}" />\n  </head>`);
  await writeFile(join(OUT, 'index.html'), outHtml);

  // 5. assertions
  const emittedCss = await readFile(join(OUT, BUNDLE), 'utf8');
  const emittedDataUrls = emittedCss.match(/url\(\s*["']?data:/gi)?.length ?? 0;
  const problems = [];
  const scripts = [...outHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  if (scripts.some((m) => !/\bsrc=/.test(m[1]) && m[2].trim())) problems.push('index.html 出现了内联 <script>');
  if (/<style\b/i.test(outHtml)) problems.push('index.html 出现了 <style>');
  if (/\sstyle=["']/i.test(outHtml)) problems.push('index.html 出现了 style= 属性');
  // Compared against the source instead of banned outright: two chevrons in styles.css already ship
  // as data: URIs, which is a pre-existing CSP question (and enhanceSelects() may replace those
  // <select> elements entirely) rather than something this step created.
  if (emittedDataUrls > sourceDataUrls)
    problems.push(
      `打包额外内联了 ${emittedDataUrls - sourceDataUrls} 个 data: URL（源里共 ${sourceDataUrls} 个）。` +
        `CSP 的 img-src 不含 data:，被拦下时控制台没有任何输出，只会看到空白图标`,
    );
  const links = styleHrefs(outHtml);
  if (links.length !== 1) problems.push(`期望 1 个样式表，实得 ${links.length} 个`);
  // Positive check, not a missing-file check: esbuild already refuses to bundle an unresolvable
  // url(), so asserting "every url() exists" would be unreachable. What CAN break silently is the
  // icons not surviving the merge at all — a loader change drops them and you get blank buttons
  // with nothing in the console. So the emitted count is compared against the source count.
  const cssRefs = [...emittedCss.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  // fluent-icons.css is one of the nine linked sheets, so this covers every source reference.
  const sourceMaskCount = (await Promise.all(sheetPaths.map((rel) => readFile(join(SRC, rel), 'utf8')))).reduce(
    (n, css) => n + (css.match(/url\(\s*["']?[^)"']*fluent-icons\//gi)?.length ?? 0),
    0,
  );
  const emittedIconCount = cssRefs.filter((ref) => ref.includes('fluent-icons/')).length;
  if (emittedIconCount < sourceMaskCount)
    problems.push(
      `源 CSS 里 ${sourceMaskCount} 个图标引用，产物里只剩 ${emittedIconCount} 个 —— ` +
        `mask 丢失不会有任何控制台输出，只会看到空白图标`,
    );
  for (const ref of [...outHtml.matchAll(/(?:src|href)=(["'])([^"']+)\1/g)].map((m) => m[2])) {
    if (/^(https?:|data:|mailto:|#)/.test(ref)) continue;
    const exists = await stat(join(OUT, ref.replace(/^\//, '')))
      .then(() => true)
      .catch(() => false);
    if (!exists) problems.push(`index.html 引用了不存在的产物：${ref}`);
  }
  if (Object.keys(result.metafile.outputs).some((p) => !resolve(OUT, p).startsWith(OUT + sep)))
    problems.push('有产物落在 out/ 之外');
  const strays = (await allFiles(OUT)).filter((rel) => rel === 'src' || rel.startsWith('src/'));
  if (strays.length) problems.push(`esbuild 逃出了 outdir，留下 ${strays.length} 个重复文件（例如 ${strays[0]}）`);

  const after = await totalBytes(OUT);
  const before = await totalBytes(SRC);
  const report = {
    schema: 'witrn-dist-build-v1',
    minify,
    stylesheetsBefore: hrefs.length,
    stylesheetsAfter: links.length,
    dataUrlsBefore: sourceDataUrls,
    dataUrlsAfter: emittedDataUrls,
    src: before,
    out: after,
    bundleBytes: (await stat(join(OUT, BUNDLE))).size,
  };
  console.log(
    `out/: ${after.count} 个文件 ${(after.bytes / 1024).toFixed(1)} KiB（源 ${before.count} / ${(before.bytes / 1024).toFixed(1)} KiB）；` +
      `样式表 ${hrefs.length} → ${links.length}，bundle ${(report.bundleBytes / 1024).toFixed(1)} KiB；` +
      `data: URL ${sourceDataUrls} → ${emittedDataUrls}${minify ? '；已 minify' : ''}`,
  );
  if (problems.length) {
    for (const p of problems) console.error(`  ! ${p}`);
    throw new Error(`out/ 的形状不合规（${problems.length} 项）`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

export { main, styleHrefs };
