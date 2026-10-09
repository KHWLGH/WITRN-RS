// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Tauri 配置契约测试。
 *
 * 要防的是"在 CI 里看不见的那一半配置"：`tauri.<os>.conf.json` 只在对应平台被读取，
 * 所以 macOS / Linux 的 CI job 永远不会碰 `tauri.windows.conf.json` —— 而那正是
 * WebView2 GPU 栅格化参数所在的地方。更要紧的是合并语义：平台文件里的 `app.windows` 是
 * **整个数组替换**，不是逐字段深合并，所以平台文件少写一个键，就等于在 Windows 上把基础
 * 配置里那个键悄悄删掉。这种丢失既没有编译错误也没有警告，只表现为"只在 Windows 上出现的
 * 行为差异"。这里把两条不变式钉住：平台文件必须覆盖基础窗口对象的全部键，且共有键的值必须
 * 与基础配置一致（平台文件只允许**加**键）。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel @returns {any} */
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const base = readJson('src-tauri/tauri.conf.json');

const PLATFORM_FILES = readdirSync(path.join(root, 'src-tauri'))
  .filter((name) => /^tauri\.(windows|macos|linux)\.conf\.json$/.test(name))
  .map((name) => `src-tauri/${name}`);

/**
 * 平台层允许改写的基础键。除此之外平台层只能加键；每一项都必须写明原因。
 * @type {Record<string, string[]>}
 */
const ALLOWED_OVERRIDES = {
  // macOS 使用系统原生红绿灯：需要系统装饰配合 Overlay 标题栏，Windows / Linux 仍为无边框自绘。
  macos: ['decorations'],
};

test('平台配置文件确实存在（否则下面的不变式是空过）', () => {
  assert.ok(PLATFORM_FILES.includes('src-tauri/tauri.windows.conf.json'), '找不到 tauri.windows.conf.json');
});

for (const rel of PLATFORM_FILES) {
  const os = path.basename(rel).slice('tauri.'.length, -'.conf.json'.length);
  test(`${os} 覆盖层不得删掉基础窗口配置的任何键`, () => {
    const platform = readJson(rel);
    const platformWindows = platform?.app?.windows;
    if (!platformWindows) return; // 没写 windows 就等于不参与合并，合法。
    assert.equal(platformWindows.length, base.app.windows.length, `${os} 层改了窗口数量`);
    const allowed = ALLOWED_OVERRIDES[os] ?? [];
    for (const [index, baseWindow] of base.app.windows.entries()) {
      const override = platformWindows[index];
      const missing = Object.keys(baseWindow).filter((key) => !(key in override));
      assert.deepEqual(
        missing,
        [],
        `数组是整体替换的：${os} 层少了这些键，等于在 ${os} 上把它们删掉了 -> ${missing.join(', ')}`,
      );
      const diverged = Object.keys(baseWindow)
        .filter((key) => !allowed.includes(key))
        .filter((key) => JSON.stringify(baseWindow[key]) !== JSON.stringify(override[key]))
        .map((key) => `${key}: 基础=${JSON.stringify(baseWindow[key])} ${os}=${JSON.stringify(override[key])}`);
      assert.deepEqual(diverged, [], `${os} 层悄悄改动了基础配置的取值（只想加键，不想改值）`);
    }
  });
}

test('macOS 使用系统原生红绿灯，并在自绘标题栏内纵向居中', () => {
  const window = readJson('src-tauri/tauri.macos.conf.json').app.windows[0];
  assert.equal(window.decorations, true, '原生红绿灯需要系统装饰');
  assert.equal(window.titleBarStyle, 'Overlay', '标题栏透明叠在网页之上，布局仍由前端决定');
  assert.equal(window.hiddenTitle, true, '隐藏系统标题文字，避免压在 Tab 上');
  // 截图实测（macOS 27.2）：按钮圆心比 y 高约 2 pt，直径 13.5 pt，圆心间距 23 pt，三颗从 x 起跨 60 pt。
  // y 取标题栏高度的一半再加 2，按钮在 100% 缩放的标题栏内居中；改标题栏高度时同步改 y。
  const tokens = readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');
  const titlebarHeight = Number(tokens.match(/--titlebar-height:\s*(\d+)px/)?.[1]);
  assert.equal(window.trafficLightPosition.y, titlebarHeight / 2 + 2, '红绿灯应在 100% 缩放的标题栏内居中');
  // CSS 预留宽度必须盖住三颗按钮，否则 Tab 会钻到按钮底下。
  const reserve = Number(tokens.match(/--window-native-controls-width:\s*(\d+)px/)?.[1]);
  assert.ok(reserve >= window.trafficLightPosition.x + 60, `预留 ${reserve}px 不足以容纳红绿灯`);
  // Windows / Linux 继续使用无边框自绘标题栏。
  assert.equal(base.app.windows[0].decorations, false);
});

test('Windows 层带上 WebView2 的 GPU 栅格化参数', () => {
  // CHANGELOG 与 docs 都宣称这项已发货；它只存在于这个文件里，所以在非 Windows 的 CI 上
  // 没有任何东西会因为它被删掉而变红。
  const windows = readJson('src-tauri/tauri.windows.conf.json').app.windows[0];
  const args = String(windows.additionalBrowserArgs ?? '');
  assert.match(args, /--enable-gpu-rasterization/);
  assert.match(args, /--enable-features=CanvasOopRasterization/);
});

test('主窗口关闭 WebView 后台节流，隐藏时采集不会因缺少 ACK 停止', () => {
  // 采集是否继续取决于前端：每批样本由 JS 消费后 ack_device_stream，未确认量达到
  // stream::UNACKED_CAP（8192）时后端停止采集并报错。macOS 的 WKWebView 默认对
  // 隐藏 / 最小化 / 被遮挡的视图采用 suspend 策略，约 5 分钟后整页挂起，1 ms 采样下
  // 约 8 秒就会触发上限。Windows 上 WebView2 最小化时仍在运行，所以只在 Windows 上
  // 验收过的后台录制，在 Mac 上并不成立。
  // tauri 把该项映射为 WKPreferences.inactiveSchedulingPolicy（macOS 14+），
  // Windows / Linux 不支持、忽略此键；平台覆盖层同样必须带上它（见上方不变式）。
  for (const window of base.app.windows) {
    assert.equal(window.backgroundThrottling, 'disabled');
  }
});

test('启动埋点阶段仍不改窗口可见性', () => {
  // 冷启动方案里 "visible:false" 被明确推迟到数字证明它值得做之后（见 docs/DEVELOPMENT.md 的
  // 冷启动分段）。这一条不是永远为真的规则，而是一个"要改就先去看那些数字"的关卡。
  for (const window of base.app.windows) {
    assert.notEqual(window.visible, false, '改成 visible:false 需要先有 bench/startup.mjs 的数字支撑');
  }
  for (const rel of PLATFORM_FILES) {
    const platform = readJson(rel);
    for (const window of platform?.app?.windows ?? []) {
      assert.notEqual(window.visible, false, `${rel}: 同上`);
    }
  }
});

test('frontendDist 与构建步骤保持配套', () => {
  // cargo 依赖 Node 这件事的全部前提就是这三行互相对齐；任何一行单独改动都会让
  // "检查的字节"和"发货的字节"脱钩（build.rs 的过期检查也只能守住其中一半）。
  assert.equal(base.build.frontendDist, '../out');
  assert.match(base.build.beforeDevCommand, /scripts\/build-dist\.mjs$/);
  assert.match(base.build.beforeBuildCommand, /scripts\/build-dist\.mjs --minify$/);
  assert.ok(
    existsSync(path.join(root, 'scripts/build-dist.mjs')),
    'frontendDist 指向 out/，但产出它的构建步骤已经不在了',
  );
});

test('macOS 打包使用 ad-hoc 签名且最低系统版本保持 12.0', () => {
  const macOS = readJson('src-tauri/tauri.macos.conf.json').bundle.macOS;
  assert.equal(macOS.signingIdentity, '-');
  assert.equal(macOS.minimumSystemVersion, '12.0');
});
