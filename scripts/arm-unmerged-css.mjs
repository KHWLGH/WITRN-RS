/**
 * Build-only scratch step for a startup A/B control arm: recreate the pre-merge frontend shape
 * inside `out/` so `cargo build` embeds an app with nine stylesheets.
 *
 * Why this exists as a script rather than a one-liner: `build-dist.mjs` deletes the nine source
 * sheets after bundling (they are dead weight in the shipped shape), so patching only `index.html`
 * produces an arm whose nine <link>s point at files that were never embedded. That arm still boots,
 * still reports every stage, and its numbers look plausible -- it is just an unstyled app. The
 * first paired run done by hand made exactly that mistake and "measured" the merge adding 8
 * requests instead of removing 8.
 *
 *   npm run build && node scripts/arm-unmerged-css.mjs && cargo build -p witrn-rs
 *   cp target/debug/witrn-rs.exe target/debug/witrn-A.exe
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../bench/common.mjs';

if (!existsSync(join(ROOT, 'out'))) throw new Error('out/ 不存在，先跑 npm run build');

const source = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
const links = [...source.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/g)].map((m) => m[0]);
if (links.length !== 9) throw new Error(`src/index.html 里应有 9 个样式表，实得 ${links.length}`);

const paths = links.map((tag) => tag.match(/href=["']([^"']+)["']/)[1].replace(/^\.?\//, ''));
for (const rel of paths) {
  mkdirSync(dirname(join(ROOT, 'out', rel)), { recursive: true });
  copyFileSync(join(ROOT, 'src', rel), join(ROOT, 'out', rel));
}

const target = join(ROOT, 'out/index.html');
const mergedTag = '<link rel="stylesheet" href="app.bundle.css" />';
const html = readFileSync(target, 'utf8');
if (!html.includes(mergedTag)) throw new Error('out/index.html 里没有合并后的 <link>，形状与预期不符');
writeFileSync(target, html.replace(mergedTag, links.join('\n      ')));

const restored = paths.filter((rel) => existsSync(join(ROOT, 'out', rel)));
if (restored.length !== paths.length) throw new Error(`只还原了 ${restored.length}/${paths.length} 个样式表`);
console.error(`A 臂就绪：${links.length} 个 <link> + ${restored.length} 个样式表文件已回到 out/`);
