← 返回 [README](../README.md)

# 开发与构建

- [环境要求](#环境要求)
- [构建与运行](#构建与运行)
- [质量检查](#质量检查)
- [CI 门禁](#-ci-门禁)
- [Linux 自行编译](#-linux-自行编译)
- [macOS 自行编译](#-macos-自行编译)
- [参与贡献](#参与贡献)

## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Rust | 1.75+ | 工作区 `rust-version`；建议用最新稳定版 |
| Tauri CLI | v2 | `cargo install tauri-cli --version "^2"` |
| Windows | 10 / 11 | 当前的开发与验证平台 |
| macOS | 12+（Apple Silicon 已验证） | 可自行编译，见 [macOS 自行编译](#-macos-自行编译) |
| MSVC Build Tools | — | Windows 上编译 Rust 需要 |
| Node.js | 20+ | **仅**用于 lint / typecheck / test |

### 关于 Node 与包管理器

这两点容易踩坑，先说清楚：

- **本项目用 npm**，不是 pnpm。仓库里提交的是 `package-lock.json`，CI 用 `npm ci`。
- **Node 完全不参与 Tauri 构建。** `tauri.conf.json` 里只有 `frontendDist: "../src"`，没有 `beforeDevCommand` / `beforeBuildCommand`，前端是不经打包器的原生 ES Modules，按原样交给 WebView。

因此：

- 构建命令是 **`cargo tauri dev` / `cargo tauri build`**，不是 `npm run tauri dev`。
- 有 `npm run build`（生成 `out/`）但**没有** `npm run dev`：`out/` 由 `beforeDevCommand` / `beforeBuildCommand` 自动产出，见「前端产物流水线」。JS 仍是原生模块、逐字复制到 `out/`；被打包的只有 CSS。`package.json` 的脚本分三组：质量检查（`test` / `typecheck` / `lint` / `format`）、构建（`build` / `build:dist`）、测量台（`bench:core` / `bench:gate` / `bench:extrema` / `bench:ui` / `bench:startup` / `bench:packaging`）。
- 没有 HMR / dev server。`frontendDist` 未配 `devUrl`，前端资源是**编译期内嵌**进二进制的：改完 `src/` 下的任何文件，需要**先 `npm run build` 重生成 `out/`，再让 cargo 重新链接**，两步都做完才可能生效。**再跑一遍已有的 `target/debug/witrn-rs.exe` 拿到的仍是旧界面**。少了第一步不会报错——它会安静地把上一版字节编进去——所以 `src-tauri/build.rs` 现在直接拒绝编译（见「前端产物流水线」）。
- cargo 的 target 目录是**仓库根**下的 `target/`（`src-tauri` 只是 workspace 成员），并不存在 `src-tauri/target/`。
- **cargo 现在依赖 Node**（自 `frontendDist` 指向 `out/` 起）：`npm run build` 是构建前置步骤，不是可选的质量检查。只有 `cargo tauri dev|build` 会自动跑它，`cargo test|check|clippy` 不会 —— 那三条由 build.rs 的过期检查兜住。

前端质量工具的版本由 `package-lock.json` 锁定：**Biome 2.4.4** 负责 JavaScript / JSON / CSS / HTML 的 lint、格式检查与导入整理；**TypeScript** 负责带 `// @ts-check` 的 JavaScript 类型检查。

## 构建与运行

```bash
git clone https://github.com/KHWLGH/WITRN-RS.git
cd WITRN-RS

# 一次性安装 Tauri CLI
cargo install tauri-cli --version "^2"

# 开发运行
cargo tauri dev

# 构建发布版
cargo tauri build
```

首次运行需要较长时间下载并编译依赖树（Tauri + WebView 绑定体量不小）。

`bundle.targets` 设为 `"all"`，即在当前主机上生成该平台所有可用格式：Windows 下是 **MSI + NSIS**，Linux 下是 deb / rpm / AppImage，macOS 下是 app / dmg。产物位于 `target/release/bundle/`。

> 发布页面提供的安装包由维护者在 Windows 上手动构建上传 —— CI **不打包**任何产物，只做编译与测试。

## 发布流程

版本号写在**三个文件**里，没有工具自动同步：

| 文件 | 位置 |
| --- | --- |
| `package.json` | `"version"` |
| `Cargo.toml` | `[workspace.package]` 的 `version`（三个成员 crate 通过 `version.workspace = true` 继承） |
| `src-tauri/tauri.conf.json` | `"version"` |

漏改一处不会有任何构建或测试报错 —— 装出来的包和源码对不上，但一切看起来都正常。所以这条不变量由 **`test/version-sync.test.js`** 守着：它断言三处一致、格式为 `X.Y.Z`，成员 crate 仍在继承而不是各写各的，以及 `macos-private-api` Cargo feature 与 `tauri.conf.json` 的 `macOSPrivateApi` 同步。该测试随 `npm test` 运行，因此 CI 每次 push / PR 都会检查。

发版步骤：

1. 三处版本号一起改。
2. 在 `CHANGELOG.md` 顶部加该版本的条目。
3. `npm test` —— 版本契约测试会确认三处已同步。
4. 提交，然后打 tag：`git tag v0.2.0 && git push origin v0.2.0`。
5. 在 Windows 上 `cargo tauri build`，把 `target/release/bundle/` 下的 MSI 与 NSIS 安装包上传到 Release 页面。

> **别漏掉第 4 步。** 历史上 `v0.1.3` 有 CHANGELOG 条目却从未打 tag，`v0.2.0` 也一样 —— 结果 README 的 release 徽标一直显示落后的 `v0.1.5`。
>
> tag 推上去时 CI 会额外跑一步 `Verify tag matches manifest version`，确认 tag 名与清单版本一致（`v0.2.0` ↔ `0.2.0`），对不上直接失败。这拦得住"tag 打错版本"，但拦不住"根本没打 tag"—— 后者只能靠这份清单。

## 质量检查

跑一遍与 CI 完全相同的检查：

```bash
npm ci
npm test                    # node --test test/，覆盖不依赖 DOM/Tauri 的纯逻辑与跨文件契约
                            # 其中 test/docs-commands.test.js 会验证本文档写的每条命令 / flag / 路径都真实存在
npm run typecheck           # tsc --noEmit -p jsconfig.json
npm run lint                # biome check --error-on-warnings .
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace      # 158 个单元 / 集成测试 + 20 个文档测试
```

`npm run format` 会应用 Biome 的安全格式化（会改文件）。`npm run lint` 把警告视为失败。

Rust 侧的三条命令都是**工作区范围**的：`--all` / `--workspace` 会同时覆盖 `src-tauri` 与 `crates/usbpd-parser`、`crates/witrn-hid`。注意不要退回到 `--manifest-path src-tauri/Cargo.toml` —— 那只会选中 `witrn-rs` 一个包，两个协议 crate 就完全漏掉了。

### 特性组合

上面那组命令走的都是默认特性。改动两个协议 crate 的 `#[cfg(feature = ...)]` 时，还要跑一遍非默认组合 —— 漏标的特性门只有在关掉对应特性时才会暴露：

```bash
for combo in \
  "-p usbpd-parser --no-default-features" \
  "-p usbpd-parser --no-default-features --features serde" \
  "-p usbpd-parser --no-default-features --features vendor-ids" \
  "-p usbpd-parser --all-features" \
  "-p witrn-hid --no-default-features" \
  "-p witrn-hid --all-features" ; do
  cargo clippy $combo --all-targets -- -D warnings && cargo test $combo
done
```

CI 的 `crate-features` job 跑的就是这一组。注意各组合的用例数**本来就不同**（`usbpd-parser` 在无特性 / `vendor-ids` / 全特性下分别是 80 / 82 / 83 个），因为部分测试本身就被特性门控着。

## 📊 性能测量

`bench/` 是测量台，不是性能优化本身。先说边界，因为**这几条边界都是实测踩出来的**，不是保守声明：

| 命令 | 量什么 | 量不到什么 |
| --- | --- | --- |
| `node bench/core.mjs` | Node 里的纯算法（列存储、条带折叠、能量积分） | UI、FPS、IPC、HID、GPU，一切渲染相关 |
| `node bench/core.mjs --compare` | 同上，跟 `bench/baselines/core.json` 比并判定回退 | 同上；且对"所有受门指标被同一倍数拖慢"的改动天生看不见 |
| `node bench/core.mjs --verify-baseline` | 基线是否还描述这份代码（输入指纹 / 指标集 / 轮次设置） | 数值 —— 这是它能安全进 CI 的原因 |
| `node bench/extrema.mjs` | 逐样本扫 vs 极值金字塔的配对 A/B | 只到算法层，它自己会打印 `NOT UI FPS` |
| `node bench/ui-runner.mjs` | 真 Edge + CDP 驱动的渲染链 | **不是**原生 WebView / HID / GPU 呈现，Tauri 是 stub；sustained 段的帧间隔类指标受浏览器帧供应支配，见下 |
| `node bench/startup.mjs` | **原生**冷启动分段（真 exe，进程启动为 t0），外加每轮 `hostProbeMs` 主机标记 | 只在 debug 构建有数据：写文件被 `debug_assertions` 门住；绝对毫秒**不跨批可比**（见下） |
| `node bench/ui-runner.mjs --dist out` | **发货产物本身**能否启动：`out/index.html` 只挂 1 个样式表、505 条规则、30 个 CSS `url()` 全部取到 | 与 `src/` 模式的计时不可比（同一个页面两种形状）；也不原生 |
| `node bench/packaging.mjs` | 发货形状：文件字节、首帧取回次数、无引用资产，以及**真正的 `frontendDist`（`out/`）里哪些文件不该被内嵌** | 不量时间，因此也不需要基线 |
| `cargo bench -p witrn-rs` | Rust 侧：`decode_general_sample` 6.5–7.0ns、JSON 编码 ~221ns/点、`Selection` 逐点成本 | WebView IPC、HID 到达、GPU；**它的 change% 也不是门禁**（同一份代码跨轮能翻到 ±20% 且仍报 p<0.05） |
| `node bench/ui-runner.mjs --shipped-csp` | 用**发货的** CSP 头服务页面，收集 `securitypolicyviolation` | 见下：默认模式下 `img-src` 允许 `data:`、`script-src` 允许 `unsafe-inline`，所以只有这个模式能回答"真实策略会不会拦" |

### 前端产物流水线

`frontendDist` 指向 **`out/`**，不是 `src/`。`out/` 由 `node scripts/build-dist.mjs` 生成：整棵 `src/` 先逐字镜像过去，然后 esbuild **在 `out/` 内部**把 9 个阻塞样式表合成 1 个 `app.bundle.css`（`--minify` 用于发布构建），SVG 以 `[dir]/[name]` 原名落回原位。JS 一个字节都不改。

三点必须知道：

- **为什么先在 `out/` 里镜像再打包**：`src/` 与 `out/` 是兄弟目录，直接从 `src/` 打包会让 esbuild 按两者共同祖先算相对路径，于是产出 `out/src/assets/…` 并把 28 个图标复制成 56 个。脚本里有一条断言专门盯着这个（`有产物落在 out/ 之外` / `留下 N 个重复文件`）。
- **cargo 从此依赖 Node，而且会拒绝过期构建**：`generate_context!` 在宏展开期嵌入 `frontendDist`，所以 `out/` 不存在时 `cargo build` / `check` / `clippy` / `test` 全部失败 —— 包括只看 Rust 的 CI job。改 `src/` 下的任何文件（CSS 与 JS 一样）都是**先 `npm run build`、再重新链接**两步，缺一不可。这条不是靠人记住的：`src-tauri/build.rs` 把 `src/` 下每个会被镜像的文件都声明成 `rerun-if-changed`，然后比较 `src/` 与 `out/` 的最新 mtime，`src/` 更新就直接 panic 让你去跑 `npm run build`。**没有这层，改完 CSS 忘记构建是一次静默的成功编译** —— `tauri-build` 只 watch `frontendDist`，所以 `cargo test` 连 build script 都不会重跑，编进去的是上一版字节。`.d.ts` 与点号目录不在 watch 列表里（它们不进 `out/`），实测改 `src/global.d.ts` 不报警、改 `src/device-stream.js` 报警。
- **`.gitignore` 拦不住内嵌，只有 mirror 的排除清单能**：`tauri-codegen` 是按文件系统递归走 `frontendDist` 的，不看 git。所以 `src/.playwright-cli/*.yml`（一个 0 字节的 Playwright 页面快照）和 `src/global.d.ts` 一度被镜像步骤复制进 `out/` 再内嵌进每个安装包 —— 前者明明已经在 `.gitignore` 里。现在 mirror 跳过点号开头与 `*.d.ts` 条目，`bench/packaging.mjs` 用 `neverShippable` 断言守着这条；同处的 `untrackedEmbedded` 断言守着另一件事：**`out/` 里有未提交的文件，就意味着这个二进制无法由干净检出复现**（本地实测点出过 7 个）。

不打包 JS 的三个理由：`tsc --noEmit` 与 `test/*.test.js` 都直接读 `src/`，打包后"检查的字节"和"发货的字节"就不是同一批；`bench/ui-server.mjs --revision <sha>` 靠 `git show <sha>:src/<path>` 服务历史代码做前后对照，这条能力只在未打包源码上存在。`--bundle-js` 目前**故意未实现**（会直接报错），因为按测量它值不值得做是一个要看数据的决定：见下面"启动的配对 A/B"里每次前端取回 ≈4ms、模块图约 19 次那笔账（上限约 80ms，不是当年估的 150ms）。

### 冷启动实测到的形状

`bench/startup.mjs` 在合并 CSS 前后各跑 5–6 次（p50，毫秒，相对进程启动）：

| 段 | 空闲批（`hostProbe` p50 9.9ms，漂移 1.02，n=4） | 同一构建、被加载的两批（`hostProbe` p50 17.3 / 81.7ms） |
| --- | --- | --- |
| `process_start` / `run_enter` / `plugins_registered` | 0 / 0 / 0 | 0 / 0 / 0 |
| `context`（webview 上下文就绪） | 482（p95 527） | 723 / 720 |
| `setup_enter` = `titlebar_created` = `material_applied` | 517 / 517 / 518 | 767 / 765 |
| `platformProbed` | 681（p95 764） | 1011 / 959 |
| `firstPaint` = `firstContentfulPaint` | 750（p95 792） | — |
| `appReady` | 811（p95 885） | 1242 / 1281 |
| 页面取回次数 / 每次取回 | **81** / 3.33ms | 79 / 4.77ms，78 / 5.95ms |

三条必须这样读结论。**第一**，本项目自己写的 Rust 初始化仍是 0ms，`context` 那几百毫秒全在 `tauri::Builder::run()` 里面（WebView2 环境创建、建窗、导航），改不动 —— 这条跨批稳定。**第二**，绝对毫秒**只在同批内可比**：同一份二进制仅主机状态不同，`context` 就在 482 与 720–723 之间跳，而 `hostProbe`（32MiB sha256）从 9.9ms 走到 81.7ms 时 `context` 却没有继续变（17.3→81.7 探测，`context` 都是 ~720；而当天最早那批没有探测值、主机更忙，同一份二进制的 `context` 是 **1414ms**），所以**探测值是"这批能不能信"的标记，不是除数**，拿它做归一化会造出根本不存在的精度。跨主机速度的归一化既然不成立，比较启动只能靠**同一批次里交替跑两个二进制**（本工具目前只有一个 `--exe`，做不到；要 claim 启动改善就得先给它加 A/B）。**第三**，取回次数本身也不是不变量（81 / 79 / 78），所以"合并 9 个样式表省下的 8 次取回值多少毫秒"这个问题在当前仪器精度下**无法归因** —— 早期文档里"首绘 723 → 645ms、约每次取回 2ms"的推导应当按"当时那一拍的读数"理解，不要当成可复现的常数；`--bundle-js` 的定价因此仍然是**未定**，而不是"已量过 ≈150ms"。

顺带修掉这条链路上一个真实的仪器缺陷：`firstPaint` 原先 5 次启动里只有 1 次取到值 —— 页面第一次上报发生在 `DOMContentLoaded` 后的第一个 rAF，那时 paint entry 常常还不存在，而 `boot-timing.json` 只有在后续 `mark` 到来时才会被再写一次。现在 `boot-timing.js` 额外注册一个 `paint` 的 `PerformanceObserver({buffered:true})`，paint 落地就再报一次，实测 5/5 都有值（719–964ms）。**在此之前文档里那行 firstPaint 是"走运的那一次"，不是 p50。**

### 启动的配对 A/B：`--exe-b`

绝对毫秒跨批不可比（上一节），所以比较两种前端形状唯一可信的做法是**同一批里交替启动两个二进制**：

```bash
# A 臂 = 合并前的形状（九个样式表）。必须用脚本，见下。
npm run build && node scripts/arm-unmerged-css.mjs
cargo build -p witrn-rs && cp target/debug/witrn-rs.exe target/debug/witrn-A.exe
# B 臂：重新产出 out/（回到发货的合并形状）并重新构建
npm run build && cargo build -p witrn-rs
node bench/startup.mjs --exe target/debug/witrn-A.exe --exe-b target/debug/witrn-rs.exe --runs 12
rm target/debug/witrn-A.exe
```

配对顺序按对翻转（a,b → b,a → …），所以"谁在_pair 里先启动"这个位置因素在两臂间均摊；每个臂各自的首次启动被排除（不是全局 `slice(1)`）。输出的 `b/a p50` 与 `b快/对` 就是判定，不需要相信绝对值。

**A 臂不能只手改 HTML**：`build-dist.mjs` 打包后会把九个源样式表从 `out/` 里删掉（它们在发货形状里是死重），所以只改 `<link>` 得到的对照组，它的九个链接指向**根本没被内嵌**的文件 —— 那个臂照样启动、照样报出每个阶段、数字看起来完全合理，只是跑的是个没有样式的页面。第一次手工配对就是这么量的，量出"合并反而多 8 个请求"，方向整个反了。`scripts/arm-unmerged-css.mjs` 负责把九个文件复制回去，并在链接数或文件数不符时直接抛错。

一次 12 启动、主机空闲（两臂 `hostProbe` 都是 9ms，未触发漂移警告）的实测：

| 指标 | A（九表） | B（合并） | b/a | b 更优/对 |
| --- | --- | --- | --- | --- |
| `resourceFrontend`（剔除 IPC 的前端请求） | 62 | **54** | 0.871 | **5/5** |
| `resourceIpc` | 28 | 28 | 1.000 | — |
| `context` | 427 | 425 | 0.978 | 3/5 |
| `platformProbed` | 589 | 585 | 1.003 | 2/5 |
| `firstPaint` = FCP | 671 | 667 | 0.996 | 4/5 |
| `appReady` | 730 | 725 | 0.994 | 3/5 |

三条读法。**一、请求数是确定性的**：A 六次全 62、B 六次全 54，正好差 8（9 → 1），零方差，而 `resourceIpc` 两臂恒等为 28 —— 这既证明 host 分组是对的，也让"少 8 次内嵌协议往返"成为可以放心引用的事实。**二、启动时间的收益是个位数毫秒**（`appReady` −5ms ≈ 0.6%，3/5 对），不是文档曾经写过的 78ms；理由要按"少 8 次往返"来陈述，不要写成"启动明显变快"。**三、这要求主机空闲**：同一份代码在被加载时 `context` 会跑到 720–1414ms，读任何结论前先看 `hostProbeMs` 和漂移警告。

`--bundle-js` 因此有了正确的算法：54 次里除去 1 个样式表 + 4 个 `<script>` + 30 个 CSS `url()`，模块图约 19 次；按本批资源段 `477 → 729ms`（252ms / 62 次 ≈ 每次 4ms）折算，打包 JS 的上限约在 **80ms 量级**，而不是先前推测的 150ms。仍然要先量再决定，别拿这个估算当依据直接动手。

**`--shipped-csp` 存在的原因**：harness 默认发的 CSP 比应用宽松（要注入 fixture stub）。副作用是 bench 永远抓不到 CSP 回归 —— 而被 `img-src` 拦下的 CSS `mask` / `background-image` 是前端最隐蔽的一类失败：不发网络请求、不抛异常、控制台安静，只留下一个空白图标。这个模式在页面上零违规时才会通过断言。

### `bench:ui` sustained 段：哪些数能读

rAF 间隔有两个来源，而**间隔本身分不开它们**：这一帧我们算慢了，或者浏览器根本没给这一帧（标签页被遮挡/节流）。一次 20s 的实跑量到了后者占绝大多数：

| 观察 | 值 |
| --- | --- |
| `rafP95ms`（全部活跃间隔） | 121.2 |
| `rafOfferedP95ms`（只算我们有机会影响的那些帧） | **6.2**（标定节奏 6.1） |
| `prepP95ms`（每帧真正执行的绘制准备工作） | 1.6，最大 3.4 |
| `longTaskOver50Ms` | **0** |
| `starvedPct` / `wallRatio` | 35% / 12.55（"20 秒"跑了 4 分钟墙钟） |

零个 long task + 每帧最多 3.4ms 的工作，就排除了"是我们算慢了"这个解释。因此结果里带一个 `timingTrust`，用**测出来的**上界（`cadence×2 + preparationMs.max`，不是魔法常数）把间隔分成"给到的帧"和"被饿到的帧"，并据此给出 `throttled`。读法：

- **可信**：`preparationMs`、`longTasks`、`emitsPerSecond`、`meanPointsPerEmit`、列 SHA / `lastSeq` 那批硬断言 —— 它们是工作量与计数，与帧供应无关。
- **只在 `throttled: false` 时可信**：`rafMs`、`requestToDrawMs`、`estimatedMissedFrameSlots`。前者现在同时给出 `rafOfferedMs`；`estimatedMissedFrameSlots` 已经只按给到的帧算，被饿到的帧不再被当成丢帧（早先一次 10s 跑因为一个 135,751ms 的挂起，把丢帧估计推到了上千）。
- 这也是**它的计时永不进门禁**的量化理由。要让 sustained 段干净，需要 Edge 窗口在整个 sustained 期间保持前台且不遮挡 —— 共享 runner 与日常开发环境都保证不了，所以这里选择把不可信标出来，而不是假装数字是好的。
- **但"窗口可见"是前置条件而不只是精度问题**：完全被遮挡时 rAF 一帧都不给，整个 sustained 段无从跑起。现在标定环节用 rAF 与 250ms 定时器赛跑（不再无限 `await`），10 秒内凑不满 20 帧就直接报"窗口被遮挡"并退出，而不是留一句 60 秒后的 `CDP timeout`；导航后会 `Page.bringToFront`。每个阶段向 stderr 打 `{stage, atMs}`，失败时能看出死在第几个 `Runtime.evaluate`。
- **`acceptanceSurface` 这一段是为发版闸门服务的**：它断言 `deviceStream.diagnostics().seq` 等于流水线报告的 `lastSeq`（实测 300 === 300），也就是 `scripts/verify-hardware-receipt.mjs` 里"应用产出点数 == CSV 行数"那条规则的前提。没有这条断言，那条规则建立在一个从未验证过的假设上。`window.__WITRN_STREAM__()` 也被断言**可调用且与单例读数完全相等**（不只是"存在"）：那是文档让人在 DevTools 里输入的入口，只检查存在性会漏掉拼错属性名这类恰好让文档失效的错误 —— 本仓库真的因为检查里少写一个尾下划线把一次成功的验收误判成"应用弄丢了自己的全局"，原因写在 CHANGELOG。

### 为什么门禁要"扣漂移 + 多轮互证"

绝对毫秒数在这类机器上不可信，实测过：同一份代码连跑三次，所有受门指标一起落在 1.12–1.50× 且逐轮上飘（构建窗口与主机降频叠加）。所以 `--compare` 从不直接读原始比值，判定链是：

1. **扣除环境漂移**：取本轮所有可门禁指标里**最小**的 base/本次比值当作机器状态。用中位数会被回退自身污染 —— 曾实测到一个只改共享热函数的 5× 回退，因为它同时抬升了多数指标，中位数被抬到 x4.32，那一轮报出了 `gate passed`。代码只会往上加成本、漂移会加在所有人身上，所以最小值才是无偏估计。
2. **按指标自身离散度降级**：某指标自己的 `p95/p50` 大于 1.5 时，15% 的阈值就落在它的噪声里，于是只报告不判定（`report-only`）。`flatten` 在 1M 下离散度实测 1.78，硬判会产生假阳性。
3. **多轮互证**：默认 3 轮（奇数，否则首轮 JIT 离群值会占到"上中位数"的一半），必须每轮都超阈才算回退。单轮误报实测出现过（adjusted x1.20，下一轮不复现）。

**这套机制挡不住什么**（同一天里实测到，别把它当保险箱）：3 轮互证是在**同一个进程内**取样的，所以挡不住"整段时间里机器都在降频"。有一次我在其他构建还没跑完时执行 `--compare`，`SeriesBuckets.rebuild.full@100000` 以 3/3 轮、扣漂移 x1.07 后仍超阈的形式报了红；等机器静下来复跑两次，同一指标变成 1/3 轮、`gate passed`。也就是说：**看到 `--compare` 变红，先确认没有别的编译/测试在跑，再复跑一次；只有跨进程也复现的才当回事。** 这也是 CI 里计时只报告、不硬门禁的另一个理由 —— 真正能扛住跨主机差异的是配对的同进程 git-revision A/B，不是存基线。

这套规则本身有测试：`test/bench-gate.test.js`。它是突变验证过的 —— 把估计量从最小值改回中位数，那条测试会红。

### 基线与结果的分工

`bench/baselines/*.json` 入库，是**投影**不是结果：只含输入 sha256、fixture 版本、受门指标集合、`--runs`/`--warmup`/`--passes` 和每项的 p50/p95。`bench/results/` 不入库（每次运行都带时间戳与逐次样本，进 git 就是永久噪声）。

- `--baseline` 用本轮结果覆盖基线；改了指标名或输入数据后必须重生成，否则 `projectBaseline` 直接抛错而不是静默少测一项。
- `--verify-baseline` 只查结构（输入指纹 / 指标集 / repeat / 轮次设置），**不比数值**，所以能安全地放进 CI：手改指纹会红，正常抖动不会。
- `--sizes` 必须覆盖基线里的每个规模，否则比较无效（会报"本次没跑 size=…"）。

> `bench:ui` 是这些工具里唯一会启动浏览器的，需要本机的 Edge；用 `WITRN_BENCH_BROWSER` 指向别的 Chromium 系浏览器。它的 `--revision HEAD|<sha>` 会通过 `git show <sha>:src/<path>` 服务历史代码做前后对照 —— 这也是前端 JS 不能被打包器合并的原因：一旦打包，就没有"按 commit 取回未打包源码"这条路了。


## 🔁 CI 门禁

`.github/workflows/ci.yml` 在**每次 push 和 PR** 时运行（无分支或路径过滤），五个 job：

| Job | 平台 | 内容 |
| --- | --- | --- |
| `validate` | `ubuntu-latest` | 装系统依赖 → `npm ci` → **`npm run build`** → `npm test` → `typecheck` → `lint` → `cargo fmt --check --all` → `cargo clippy --workspace -D warnings` → `cargo test --workspace` |
| `backend-other-platforms` | `windows-latest` | `npm ci && npm run build` → `cargo test --workspace` |
| | `macos-latest` | `npm ci && npm run build` → `cargo check --workspace --all-targets` |
| `crate-features` | `ubuntu-latest` | 对两个协议 crate 的 6 组非默认特性组合逐个跑 clippy 与 test（**不需要** `out/`：这些组合根本不构建 `src-tauri`） |
| `perf-shape` | `ubuntu-latest` | 硬门禁只放确定性检查：先 `npm run build` 产出 `out/`，再跑 `bench/packaging.mjs` 断言（含"内嵌集合里不许有未提交文件 / 声明文件"）+ `core.mjs --verify-baseline` 结构校验。计时（`--compare` 与 `cargo bench`）**只报告**，见下 |
| `ui-integrity` | `windows-latest` | `bench:ui` 的**硬断言**（11 列 SHA-256、`lastSeq === count`、能量积分、并发 CSV 导出回环、零运行时异常），并用 `--shipped-csp` 以真实发货策略服务，因此同时门禁 CSP 回归。它的计时不进门禁 |

前三个 job 的 cargo 步骤都**依赖 Node**：`frontendDist` 指向 `out/`，`generate_context!` 在宏展开期就嵌入它，目录不存在时 `cargo build` / `check` / `clippy` / `test` 一起失败 —— 包括原本只看 Rust、不需要 Node 的 `backend-other-platforms`。

Rust 步骤都是工作区范围，因此 `src-tauri` 与两个协议 crate 一并受检。除 `crate-features` 外各 job 都启用了 `Swatinem/rust-cache@v2` 缓存依赖编译产物。

**为什么计时不硬门禁**：在同一台机器上实测，未改代码连跑三次，全部受门指标一起落在 1.12–1.50× 且逐轮上飘；`--compare` 已经用"扣漂移 + 3 轮互证"自我防护，但共享 runner 上的余量还不知道是多少，所以先 `continue-on-error: true` 观察。**把它改成真门禁的前提是先观察到一段安静期** —— 一个会莫名变红、于是被人忽略的门禁比没有门禁更糟。手改基线由 `validate` 里的 `--verify-baseline` 拦住。

`on: push` 没有分支或路径过滤，因此**推 tag 也会触发 CI**。`validate` 里有一步 `Verify tag matches manifest version` 只在 `refs/tags/v*` 上运行，断言 tag 名与 `package.json` 的版本号一致。

CI **不做**的事：不构建安装包、不发布 Release。发版是手动流程，见 [发布流程](#发布流程)。

### 提交前后：干净检出模拟

CI 跑的是"提交之后"的树，而本地工作区永远比它多出 `out/`、`target/`、`bench/results/` 和未提交的散落文件 —— 这三类差别里，任何一条都能让"本地全绿、CI 红"或反过来。想提前知道答案，就把**将要提交的文件集**复制到空目录里当一次干净检出跑：

```bash
D=$(mktemp -d) && cd 仓库根
{ git ls-files; git status --porcelain -uall | sed -n 's/^?? //p'; } \
  | grep -v -e '^target/' -e '^out/' -e '^node_modules/' -e '^bench/results/' | sort -u \
  | tar -cf - -T - | (cd "$D" && tar -xf -)
ln -s 仓库根/node_modules "$D/node_modules"        # 只为省掉 npm ci，测的是清单完整性
cd "$D" && git init -q -b main . && git add -A && git commit -qm snapshot
npm test && npm run lint && npm run typecheck
npm run build && node bench/packaging.mjs && node bench/core.mjs --verify-baseline
```

要看的是三件事：**`npm test` 的用例数必须与工作区完全一致**（少跑一个测试文件时它静默变少，这是清单完整性最灵敏的信号）、`bench/packaging.mjs` 的三条内嵌断言全过（`out/` 里每个文件都已跟踪、没有声明文件或工具散落文件）、`--verify-baseline` 结构一致。这条模拟已经抓到过一次真问题：`packaging.mjs` 在 `frontendDist` 不存在时以前是**打印一句"跳过"然后 exit 0**，即两条最要紧的断言在干净检出里根本不可达 —— 现在改成断言失败。

### 发版前置：真机验收凭据

100 Hz × 600 秒的真机长跑没法在托管 runner 上复现（没有 HID 设备），所以 `.github/workflows/release-perf.yml` 是一个 `workflow_dispatch`，它**不替你打 tag、不发 Release、不构建安装包**，只做机器能判的那一半：回执自洽、且回执测的就是这个 tag 里的代码。

凭据不是手填的汇总数字，而是从**导出的 CSV** 与**应用自己的计数**一起算出来的。"100 Hz 跑满 600 秒且没丢点"这个命题里，能由 CSV 证明的是：行数与跨度自洽（60,000 行 / `RelativeTime(s)` 步进 ~0.01s）、无重复、不倒退、不跨分段；而"设备到文件之间有没有少"只能由 `window.__WITRN_STREAM__()` 的 `seq` 与行数比出来（见下面"空洞不参与判决"那一节：单靠文件既定不了罪，也证不了清白）：

```bash
# 真机跑完 600 秒后：在应用 DevTools 里执行 window.__WITRN_STREAM__() 并整段复制返回值，
# 再在应用里导出 CSV，然后：
npm run verify:hardware -- --csv 导出文件.csv --diagnostics '{"seq":60000,"streamErrors":0,"capacityErrors":0,...}' \
  --hz 100 --min-duration 600 --commit "$(git rev-parse HEAD)" --receipt-out acceptance.json
npm run check:release-tag -- --tag v0.2.2 --receipt acceptance.json
```

`--diagnostics` 是**必填**的，缺了就直接拒绝出回执。理由：只读 CSV 只能证明"这份文件自身规矩"，证明不了"从设备到文件之间没丢东西"；应用侧的 `seq`（emitter 交出了多少点）与 CSV 行数一比对，链路中间的丢失才现形。同理 `streamErrors` / `capacityErrors` 也从这里读，**校验器不会替你填 0** —— 早先的版本会把这两个字段硬编码成 0，即"门禁自己声明自己通过"，属于典型的空转检查。计数在 `src/device-stream.js` 里只有一个落点：内部 `fail()`（seq 空洞、时间戳非法）与 IPC 侧 `handleError()` 都往同一张表里记，中途重连过的运行会因此报红，应当重测而不是被闸门放行。

校验器会拒的情况（每种都有 `test/hardware-receipt.test.js` / `test/device-stream.test.js` 的用例钉住）：连续断 5 个采样点造成的空洞、时间戳倒退、重复点、速率偏离标称 >2%、覆盖时长不足、**损坏行**、`producedSeq - rows` **超出一整批（64 点）**、**跨多个录制分段**、以及回执里缺声明字段。反过来，`producedSeq > rows` 而文件里**没有**空洞，现在记成 `boundaryResiduePoints` 并放行：停止录制是异步的，收尾那几批照样推进 `seq` 却不再落盘 —— 早先的版本因此把一次真正干净的 622 秒长跑判成"链路中间丢了 30 点"，那是一句 attribution 未经检验的报错，比没有门禁更糟。**空洞不参与判决，只被报告。** 曾经有一条判据是"文件里出现 ≥1.9× 标称周期的 `RelativeTime(s)` 空洞 = 少写了采样点"，它被真机 4 Hz 跑推翻了：那次录制有 7 处 ~1.96× 的洞，而应用侧计数说 `488 产出 / 486 行`（差 2，正是停止录制的异步尾），也就是**数据一件没少**。低频下选点网格在主机停顿后会重新锚定、合并掉一个网格槽，洞于是合法出现。现在唯一能定罪的丢点判据是"产出与行数的差超出一整批（`BOUNDARY_SLACK_POINTS = 64`）"，比例级缺失另由 `rows + missingRows = expectedRows` 的算术抓住；代价也说清：**小比例的内部抽行（若干行 ≤64）从文件本身无法与合法停顿区分**，所以这条门不声称能抓它。`singlePointHoles` / `maxGapMs` 仍是必填字段，因为"交付节拍被拉长过"必须看得见。"损坏行"这一条是它不复用 `src/csv-codec.js` 的 `parseCsv` 的唯一原因：导入器为了"用户重载旧文件不炸"会静默跳过畸形行，而一个照抄这种宽容的校验器会把 59,000/60,000 行判成干净。

**验收必须是"一次连续录制"，中途不要按暂停。** 暂停期间 `addDataPoint` 直接 return，文件里会留下合法的时间空洞，而 `deviceStream.seq` 继续前进 —— 所以暂停既不是丢点（跨分段的空洞单独计成 `pauseHoles`，不算 `gapsOverTolerance`），也不能被当成通过了（检测到 >1 个分段就直接拒，并让你重跑）。两个方向都有测试钉住；而同一段内的同类洞**不再**算丢点（理由见上一段的 4 Hz 实测），只作为 `singlePointHoles` 报告出来给人看。

**速率是文件的属性，不是你打的参数。** 导出头部里有 `SampTime(ms)`（就是应用里的 `settings.sampleRate`，单位毫秒：`10` 表示 100 Hz），校验器会核对 `1000 / SampTime` 与 `--hz` 是否一致，不一致直接拒 —— 否则"这是不是一次 100 Hz 验收"取决于操作者在命令行里写了什么。头里的 `SUM`（行数）只报不判：导入器本来就不信它（被 Excel 重存、被截断的文件都存在），验收判断同理。

`check:release-tag` 管另一头：tag 处的 `package.json` / `tauri.conf.json` / 根 `Cargo.toml` 三处版本必须都等于去掉 `v` 的 tag 名，且回执里的 `commit` 必须是该 tag 的祖先 —— 否则"验收通过的代码"和"用户下载到的代码"不是一份东西。这两条都在本地就能跑（本仓库现成的 tag 就是测试样本：`--tag v0.2.1` 绿、不存在的 tag 红、把回执 commit 换成 tag 之后的 commit 红）。

### 凭据是怎么被自动跑出来的（真机）

`node scripts/hardware-acceptance.mjs --seconds 620`（等价 `npm run accept:hardware -- --seconds 620`）驱动**正在运行的那个应用**（不是重写一遍采集）：应用要用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 启动，脚本经 CDP 调用应用自己的 `clearChart()`、录制开关和 `snapshotCsvColumns` + `formatCsvChunks`，因此文件里证明的是发货路径而不是一个长得像它的脚手架。参数：`--port`（默认 9223）、`--out-dir`（默认 `bench/results`）、`--poll-ms`（默认 20000）。**验收一个候选版本时要把这条命令指向 `target/release/witrn-rs.exe`（或安装后的 exe）**，debug 构建只能用来定位问题。

它先 `clearChart()` 再判活，两件事都是被实测逼出来的：导出是对**活列**做的，上一轮遗留的点会被算进本窗口（并且被校验器读成"跨分段"）；而 `seq` 只在同一 generation 内单调，`ended` 在停止录制时会翻真，所以"活着"必须由 `generation` 不变且 `seq` 递增来证明，不能看 UI 标志。`--seconds < 60` 直接拒绝，因为一次不够长跑的窗口没有验收意义。驱动与校验器之间的交接面由 `test/acceptance-tool.test.js` 钉住：它对坏参数（`--seconds abc` / `3` / `Infinity`、`--poll-ms 5`、死端口、读不到的 `--exe`）逐条断言"必须拒绝且给出可懂的报错"，并把驱动打印的那条 `verify:hardware` 里出现的每个 flag 真的喂给校验器 —— 有 flag 改名就会红（这条已经用突变验过）。

产物是 `acceptance.csv` 与 `acceptance-diagnostics.json`，脚本最后打印出可直接执行的 `verify:hardware` 命令（`--diagnostics` 从那份 JSON 读，不给人手填 0 的机会）。给它 `--exe target/release/witrn-rs.exe` 会把被测产物的 sha256 一并记进回执。**回执现在还带着溯源字段**（`provenance.headCommit` / `provenance.treeClean` / 可选 `exeSha256`），校验器对它们默认拒绝：工作树不干净、或 `headCommit` 与 `--commit` 不是同一份代码，都不能当发版凭据 —— 2026-09-25 那两次 620 秒长跑就撞在这条上（它们的数据链路完全干净，但 exe 里带着几十个未提交的改动，于是"验收通过的代码"在仓库里根本不存在）。正确顺序是：**先提交，再用提交后的构建跑验收**。它还会在 CSV 之外报告 `emits/s` 与 `points/emit`（`window.__emitProbe` 包住 `handleBatch`）—— debug 构建的 `bus-probe` 行给的是 `offers/s` vs `selects/s`（设备给了多少 vs 我们留下多少），两组数合起来才能区分"设备没发"、"节拍门丢了"和"合批没生效"这三种完全不同的故障。0.2.x 的真实历史是：`offers 100.0/s selects 56.7/s` 与 `emits 16.6/s、3.4 点/emit` 同时成立，即节拍门在丢四成数据而合批是正常的。

## 🐧 Linux 自行编译

> Linux 构建与运行**未经过持续验证**（CI 只在 Linux 上编译和测试，不实际运行 GUI，也不接触真实硬件）。以下步骤以 Debian / Ubuntu 系为例。

### 系统依赖

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config \
  libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf
```

`libudev-dev` 是 HID 访问必需的，`libxdo-dev` 是 Tauri 的依赖 —— 两者容易漏装。

### 构建

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version "^2"

git clone https://github.com/KHWLGH/WITRN-RS.git
cd WITRN-RS
cargo tauri build
```

产物在 `target/release/bundle/`（deb / rpm / AppImage）。

### udev 规则（必需）

**这一步不做的话，应用能正常启动但设备列表永远是空的，而且没有任何报错。**

`hidapi` 在 Linux 上通过 `/dev/hidrawN` 访问设备，默认只有 root 有读写权限。给维简的厂商 VID `0x0716` 加一条规则：

```bash
sudo tee /etc/udev/rules.d/99-witrn.rules > /dev/null <<'EOF'
# WITRN USB power meters (VID 0x0716) — 允许普通用户访问 hidraw
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", MODE="0666", TAG+="uaccess"
EOF

sudo udevadm control --reload-rules
sudo udevadm trigger
```

然后重新插拔仪表。`TAG+="uaccess"` 会把权限授予当前本地登录会话的用户，比单纯的 `MODE="0666"` 更严谨；两者一起写是为了兼容没有 systemd-logind 的环境。

验证是否生效：

```bash
ls -l /dev/hidraw*        # 应能看到你的用户可读写的设备节点
```

### 已知的 Linux 适配点

代码里有几处针对 WebKitGTK 的处理，了解一下有助于排查：

- WebKitGTK 用原生 GTK 控件渲染展开的 `<select>`，CSS 管不到（暗色主题下永远是白底黑字）。因此下拉框是自绘组件（`src/dropdown.js`），并设置了 `color-scheme: dark`。
- 标题栏按钮在 Linux 上自绘（`decorum` 插件只支持 Windows），边缘与四角是透明的命中区，调用 `startResizeDragging()`；另外补了 1px 描边来补偿缺失的窗口阴影。
- 对缺少 `HTMLDialogElement` 的旧版 WebKitGTK 有透明度回退。

## 🍎 macOS 自行编译

> 预构建安装包不含 macOS。Apple Silicon 上已有一次完整的 `.app` / DMG 打包记录，见 [macOS ARM64 构建记录](MACOS_BUILD.md)。CI 在 `macos-latest` 上只做 `cargo check`，不跑 GUI，也不接触真机。

需要 Xcode Command Line Tools、Rust 稳定版和 Tauri CLI v2。在仓库根目录：

```bash
npm ci
cargo tauri build
```

产物在 `target/release/bundle/`（`.app` / `.dmg`）。

透明无边框窗口依赖 Tauri 的 macOS private API：`src-tauri/Cargo.toml` 启用 `macos-private-api`，且 `tauri.conf.json` 与 `tauri.macos.conf.json` 均设置 `app.macOSPrivateApi: true`。两边必须一致——`cargo test` / `clippy` 不合并平台 overlay。`tauri-plugin-decorum` 在 macOS 上会因缺少 Cocoa superview 空指针崩溃，因此 `src-tauri/src/lib.rs` 仅在非 macOS 上初始化该插件；窗口按钮由前端自绘。

本仓库不提供 Developer ID 签名或 Apple 公证。本地包可用 ad-hoc `codesign`；首次打开可能被 Gatekeeper 拦截。DMG 若在锁屏桌面上失败，可用 `--skip-jenkins` 跳过 Finder 美化。命令、校验和与验收边界以 [macOS ARM64 构建记录](MACOS_BUILD.md) 为准。

## 参与贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'Add amazing feature'`
4. 推送到分支：`git push origin feature/amazing-feature`
5. 开启 Pull Request

### 提交前请注意

- **跑完 [质量检查](#质量检查)。** CI 在 push 和 PR 上都会执行，且是硬门禁：Biome 警告视为错误，Clippy 带 `-D warnings`，`cargo fmt --check` 不容忍格式差异。
- **换行统一 LF。** `.editorconfig`、Biome 和 `.gitattributes` 三处共同约束，Windows 上注意 Git 的 `core.autocrlf` 设置。
- **前端模块保持 `// @ts-check`。** 新增模块请一并加上，`npm run typecheck` 会检查。
- **新增 DOM 控件时注意 `test/ids.test.js`。** 它要求 JS 里 `getElementById` 引用的每个 id 在 `index.html` 中恰好出现一次。
- **改版本号时三处一起改。** `test/version-sync.test.js` 会拦下只改了一处的提交，详见 [发布流程](#发布流程)。
- **纯逻辑请抽成纯函数。** 参考 `src/measurement.js` 与 `src/pd-model.js` —— 不碰 DOM 与 Tauri 的部分单独成模块，才能在 `node --test` 里直接测。
- **新增设备型号或固件前先验证字节布局。** HID 报文目前没有校验和验证，用实机样本确认偏移与量程后再加进 `KNOWN_DEVICES`。
