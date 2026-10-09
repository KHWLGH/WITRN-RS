[English](en/DEVELOPMENT.md) | **简体中文** | [繁體中文](zh-TW/DEVELOPMENT.md) | [日本語](ja/DEVELOPMENT.md)

← 返回 [README](../README.zh-CN.md)

# 开发与构建

- [环境要求](#环境要求)
- [构建与运行](#构建与运行)
- [发布流程](#发布流程)
- [质量检查](#质量检查)
- [测试与回归边界](#测试与回归边界)
- [开发展示工具](#开发展示工具)
- [性能测量](#性能测量)
- [CI 门禁](#ci-门禁)
- [Linux 自行编译](#linux-自行编译)
- [macOS 自行编译](#macos-自行编译)
- [参与贡献](#参与贡献)

## 语言选择

在「设置 → 外观 → 语言」可选择跟随系统、简体中文、繁體中文、English、日本語。切换立即生效并保存偏好，保留连接、记录、数据、图表范围、筛选和选中报文；重置设置回到自动模式。

Linux 按第一项非空的 LC_ALL → LC_MESSAGES → LANG 检测；Windows／macOS 使用原生系统 locale。原生不可用时采用 WebView 首选语言，最终回退英文。Hans 优先选择简中、Hant 优先选择繁中；否则 CN／SG 和无区域 zh 为简中，TW／HK／MO 为繁中，ja 为日文，其余含 C／POSIX 为英文。统一处理大小写、下划线、编码与修饰后缀；手动选择覆盖自动检测。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 词典维护与翻译检查

src/i18n.js 提供 t(key, params)、locale 解析和语言变更订阅，四份词典离线打包，英文作为基准与缺词回退。src/i18n-messages.js 的四列依次为英文、简中、繁中、日文。使用语义键名，保持插值参数名称一致；含数量的消息按需补充单数版本。用户文档以简中版本为内容基准，其他语言的内容由人工校对。

静态 HTML 使用英文兜底和 data-i18n／data-i18n-title／data-i18n-placeholder／data-i18n-aria-label／data-i18n-alt；含图标或输入控件的元素只标记文字 span。动态内容通过 t 生成，持续通知和日志用延迟文字函数。切换只刷新标签、菜单、下拉和图表，不能重新连接或重建数据。

应用后端错误使用 {code, params, detail?}，异步事件保留原有字段并添加 description；前端翻译 code，保留原始诊断，仍兼容插件字符串错误。文件对话框标题与过滤器由前端翻译，原生按钮跟随 OS。PD 标准名、解码字段、原始回复、单位和 CSV／PD 数据格式保持兼容。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

检查四语、浅深主题、900×600／1280×800、连接和记录／PDM 状态、PD 选择和筛选、CSV／PD 往返、错误、文件入口及无障碍标签。Linux AppImage 的 LANG／LC_* 实机启动验收需在 Linux 完成，浏览器模拟不替代原生或硬件验收。

[本次 i18n 验证记录（英文）](I18N_VALIDATION.md)列出已完成检查及实机验收范围。


## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作区 `rust-version` |
| Tauri CLI | 2.12.1 | npm 锁定的 `@tauri-apps/cli`，通过 `npx --no-install tauri` 调用 |
| Windows | 10 / 11 | 当前开发与验证平台 |
| macOS | 12+ | 最低部署目标；CI 使用 macOS 26，旧系统兼容性需实机验证 |
| Node.js | 24 | CI、lint / typecheck / test / 前端产物 |

项目使用 npm，提交 `package-lock.json`，CI 使用 `npm ci`。前端是原生 ES Modules，`frontendDist` 指向构建生成的 `out/`；Node 不参与 Rust 编译，但 `npm run build` 必须先于 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`。改动 `src/` 后先重建 `out/`，再重新链接 Rust 二进制。

## 构建与运行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run build
npx --no-install tauri dev
npx --no-install tauri build
```

本机未指定 target 时，发布产物位于 `target/release/bundle/`；CI 显式指定 target，产物位于 `target/<target>/release/bundle/`。Tauri CLI 会自动运行 `beforeBuildCommand` 生成压缩前端，打包前无需再手动执行 `npm run build:dist`。直接运行 Cargo 检查时仍须先生成 `out/`。

## 发布流程

开发时统一使用以下命令设置版本号，无需逐个文件手改：

```bash
npm run version:set -- 0.2.3
```

将 `0.2.3` 换成目标版本即可。命令接受不含前导零的 `X.Y.Z`，先校验所有文件，再同步以下位置；重复设置同一版本不会重复写入，也不会创建 Git 提交或 tag、更新依赖或修改更新日志：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 顶层与根包 `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 所有工作区成员包的 `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust 成员 crate 继续通过 `version.workspace = true` 继承版本；关于页从 Tauri 读取版本，开发展示工具从 `package.json` 读取版本。更新后重新构建，才能让可执行文件和安装包使用新版本。

`test/version-sync.test.js` 会检查清单与锁文件一致、语义版本格式、workspace 继承关系、统一更新命令和 macOS private API 配置。正式发布时整理 `CHANGELOG.md`，将对应的 `Unreleased` 内容归入新版本。

### 手动构建与首次验收

将 workflow 提交到默认分支后，在 GitHub 的 **Actions → CI → Run workflow** 选择要验证的分支或 Tag。手动触发会先运行现有质量检查，再打包四个目标；不会创建或公开 Release，即使选择的是版本 Tag。

| 目标 | Runner | Rust target | 安装包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

每个成功目标提供独立的 `packages-*` 附件，保留 14 天。四目标全部成功后提供 `release-packages`，包含七个安装包与 `SHA256SUMS`；在解压目录中可用 `sha256sum -c SHA256SUMS` 校验。安装包名包含版本与平台架构，NSIS EXE 另带 `_setup`。

首次启用 Tag 自动发布前，先手动构建，检查 Windows 安装、两种 Mac 启动、Linux 安装及配置 udev 后的设备连接。macOS 12 兼容性需要单独实机验证。CI 验证 Mac 的架构、ad-hoc 签名、最低系统版本元数据和 DMG 完整性，不运行 GUI 或连接仪表。

macOS 构建显式使用 `--bundles app,dmg`：Tauri 在仅构建 DMG 时会清理临时 `.app`，同时指定 APP 才能保留应用供后续校验。附件收集仍只包含 DMG，不额外发布 APP。

### 推送版本 Tag 自动发布

完成上述首次验收后，更新版本、整理更新日志、运行质量检查并提交，再推送与清单一致的 Tag，例如：

```bash
git tag v0.2.3
git push origin v0.2.3
```

Tag 必须为 `vX.Y.Z`，且与清单版本一致；不一致会在打包前失败。CI 使用 Node.js 24、Rust stable、固定的 Tauri CLI 2.12.1 和 `tauri-apps/tauri-action@v1`。npm 通过 `npm ci` 安装，Cargo 使用 `--locked`；Rust 缓存按目标区分并指向工作区根目录 `target/`。Linux 固定 Ubuntu 22.04，以减少对较新 glibc 的依赖。

只有全部质量检查与四目标打包成功，才会汇总七个安装包并生成校验和。发布任务使用运行仓库的 `GITHUB_TOKEN` 创建临时草稿，上传七个包与校验文件，再核对远端附件数量、大小和 SHA-256，最后自动公开正式 Release。无需人工点击 Publish，也不需要另设 PAT；只有发布任务获得 `contents: write`，仓库的组织策略需允许这项权限。

中文发布说明由 `scripts/release.mjs` 提取 `CHANGELOG.md` 中与当前版本完全匹配的章节，将分类标题转为中文，补充三平台安装说明和校验和说明。相对文档链接自动指向该 Tag 的文件，不使用 GitHub 自动生成的提交/PR 摘要。版本章节缺失、重复或为空时，发布在调用 GitHub API 前失败；草稿重跑时也会更新发布说明。可设置 `GITHUB_REPOSITORY=KHWLGH/laPower` 后运行 `node scripts/release.mjs notes`，在 `dist/release-notes.md` 预览。

同一 ref 的运行串行处理，不取消正在上传的发布。上传或验证失败时 Release 保持草稿；在 Actions 重跑失败任务即可复用该草稿并替换本次发布的同名附件。草稿若包含其他附件，须人工检查后再重跑；同名 Release 已公开时，任务拒绝自动覆盖。若需修改已发布的二进制，应更新版本并推送新 Tag。

Windows 当前不做证书签名；macOS 使用 ad-hoc 签名，没有 Developer ID 签名和公证；Linux 安装包不会自动设置 udev 权限。本流程不启用自动更新，不构建 Windows/Linux ARM64 或 Mac Universal 包。

## 质量检查

```bash
npm ci
npm run build
npm test
npm run typecheck
npm run lint
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`npm test` 使用 Node 内置测试运行器，覆盖纯逻辑、数据处理、协议/文件契约、安全边界和版本同步。测试文件按核心领域组织，当前保留的主要文件包括：

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace 测试、格式检查、Clippy 和协议 crate 的 feature 组合检查继续保留。涉及 `usbpd-parser` 或 `witrn-hid` 的 feature 门时，按 CI 的组合补跑：

```bash
for combo in \
  "-p usbpd-parser --no-default-features" \
  "-p usbpd-parser --no-default-features --features serde" \
  "-p usbpd-parser --no-default-features --features vendor-ids" \
  "-p usbpd-parser --all-features" \
  "-p witrn-hid --no-default-features" \
  "-p witrn-hid --all-features"; do
  cargo clippy $combo --all-targets -- -D warnings && cargo test $combo
done
```

## 测试与回归边界

- 普通功能增加、删除、重命名，UI 布局、样式、文案和选项列表变化，默认不新增回归测试。
- 只有涉及数据丢失或损坏、协议兼容、崩溃或死锁、安全边界、发布构建不变量，或已经确认的高影响历史缺陷时才增加测试。
- 优先补充现有核心测试，不为每个小功能新建测试文件、设计方案或 CI job。
- 性能 benchmark 和真机检查按需手动运行，不作为每次改动的浏览器自动回归。
- CI 保持固定的核心检查集合，不因单个功能增加专用回归流程。

## 开发展示工具

`tools/showcase/` 是独立的浏览器开发工具，提供虚拟 WITRN K2 与 POWER-Z KM003C、确定性的测量曲线、PD 报文和协议控制结果。数据仍经过软件现有摄入与渲染逻辑；完整标题栏使用 decorum 同款控件结构与软件自身的图标、样式，窗口行为虚拟化。工具不连接真实仪表，不进入 `src/`、`out/` 或安装包，也不加入浏览器 CI。

首次准备：

```bash
npm ci
npx playwright install chromium
```

交互预览与生成全部展示图：

```bash
npm run showcase:dev
npm run showcase:capture
```

预览默认监听 `http://127.0.0.1:4173`，默认显示浅色主题；独立软件视图可用 `/app/?theme=dark` 或 `/app/?theme=system` 指定深色或跟随系统。软件标题栏可选择虚拟设备、连接与断开，记录按钮可开始和暂停。开发工具外层提供「填充 120 秒展示数据」「冻结」「继续模拟」「推进 10 秒」「重置预览」；填充按钮自动连接当前选择的设备与本机温度源并开始记录。协议控制需要选择 POWER-Z 并连接，然后打开 PDM。端口可用 `npm run showcase:dev -- --port 4174` 指定，服务只监听本机。

截图命令使用 Chromium、Windows 风格、1280×800 CSS 视口、2 倍像素密度及 100% 界面缩放，生成 2560×1600 PNG。默认使用 POWER-Z、本机温度源与相同的 120 秒模拟数据，先冻结虚拟时间，再等待实际图表、报文详情、字体与控件渲染完成。输出为 `docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png`，每种语言各 8 张展示图（共 32 张）。

可以只截取指定页面、主题或更改输出目录：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` 支持 zh-CN、zh-TW、en、ja（逗号分隔，默认全部）；`--theme` 支持 `light,dark`，默认按浅色、深色顺序生成；`--page` 支持 `record,pd,trigger,settings`。输出目录相对于仓库根目录，也可使用绝对路径。修改 `tools/showcase/scenario.js` 可以调整虚拟设备信息、随机种子、充电曲线、握手时刻及 PDO / 协议检测结果。`bridge.js` 实现 Tauri 命令、事件、录制段、ACK、内存设置与文件句柄；未实现的调用会明确报错。CSV / PD 导出通过浏览器下载，CSV 导入通过浏览器文件选择器；PD 导入仅支持包含已固化样例原始报文的文件，任意真机报文解码仍应使用原生软件。

`pd-fixtures.json` 保存由现有 `witrn-hid` Rust 解析器产生的原始报文与解码树，普通预览和截图无需 Rust 编译。更改 PD 原始样例后，可在安装 Rust 的环境中运行 `node tools/showcase/generate-pd.mjs` 重新生成；临时生成器写入忽略的 `output/`，编译产物写入 `target/`。

浏览器上下文使用内存设置与文件，不读写真实应用的数据目录。软件使用新的标识 `io.github.khwlgh.lapower`，启动测量工具也已同步该标识；旧 WITRN-RS 设置不会自动迁移。

## 性能测量

`bench/` 保留算法、存储、启动、极值和发货形状检查；浏览器 harness、浏览器长跑和硬件验收已移除。

| 命令 | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列存储、分桶、统计和能量积分基准 |
| `node bench/core.mjs --compare` | 与算法基线比较，结果需结合多轮和主机状态判断 |
| `node bench/core.mjs --verify-baseline` | 单次正确性检查及基线结构校验，不预热、不计时 |
| `node bench/phase2.mjs` | 范围统计和协作切片的前后版本对照 |
| `node bench/phase3.mjs` | 分块存储、统计和能量计算的前后版本对照 |
| `node bench/extrema.mjs` | 扫描与极值索引的算法对照 |
| `node bench/startup.mjs` | 原生二进制冷启动分段，按需手动运行 |
| `node bench/packaging.mjs` | 检查 `out/` 的发货文件和内嵌集合 |
| `cargo bench -p lapower` | Rust 协议解码、编码和选择路径基准 |

`perf-shape` CI job 只硬性检查发货形状和基线结构；算法和 Rust benchmark 只报告结果，不把单次耗时当作跨主机门禁。

## CI 门禁

`.github/workflows/ci.yml` 在每次 push 和 PR 运行固定的核心检查：

| Job | 内容 |
| --- | --- |
| `validate` | Linux 依赖、前端构建、JS 测试、typecheck、lint、Rust fmt、Clippy、workspace test |
| `backend-other-platforms` | Windows workspace test；macOS workspace check |
| `crate-features` | 协议 crate 的非默认 feature 组合 Clippy 与 test |
| `perf-shape` | `bench/packaging.mjs`、`core.mjs --verify-baseline`，以及报告型 benchmark |
| `package` | 仅版本 Tag push / 手动触发；依赖以上四项检查，四目标并行打包，单个平台失败不会取消其他目标 |
| `package-summary` | 四目标全部成功后验证七个安装包并生成 `SHA256SUMS` |
| `release` | 仅版本 Tag push；上传并核对附件后自动公开 Release |

普通分支 push 和 PR 只运行原有检查，不打包或发布。CI 不运行浏览器验收、硬件长跑或功能表面回归。开发展示工具仅用于按需预览和生成文档图片，不承担浏览器验收或 CI 门禁；新增功能不应顺手增加专用 workflow、job 或回归 harness。发布脚本的失败、重跑、附件完整性和公开版本保护由 `test/release.test.js` 离线验证。

## Linux 自行编译

Linux 构建与运行未持续接入真实设备验证。Debian / Ubuntu 依赖：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

需要访问 WITRN HID 时，按发行版配置 `/dev/hidraw*` 的 udev 规则。

### udev 规则（必需）

Debian / Ubuntu 上可创建 `/etc/udev/rules.d/99-lapower.rules`，仅授予当前桌面用户访问 WITRN HID 和 POWER-Z USB 接口的权限：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

随后执行 `sudo udevadm control --reload-rules`，重新插拔设备，再启动软件。`uaccess` 依赖 systemd-logind 的活动本地会话；其他发行版或无桌面会话环境应使用发行版的设备访问组规则。POWER-Z 协议控制还需要访问其 CDC 串口。

## macOS 自行编译

需要 Xcode Command Line Tools、Rust 稳定版和 npm 锁定的 Tauri CLI：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API 的 Cargo feature 与 Tauri 配置必须保持一致。平台配置使用 `signingIdentity: "-"` 和 `minimumSystemVersion: "12.0"`；CI 同时设置 `MACOSX_DEPLOYMENT_TARGET=12.0`，保留旧系统部署目标，并通过 `CI=true`、`TAURI_BUNDLER_DMG_IGNORE_CI=false` 跳过 Finder 美化。当前没有 Developer ID 签名或 Apple 公证；首次打开方式见 [README 下载与安装](../README.zh-CN.md#-下载与安装)。

普通 macOS CI 做 workspace check；版本 Tag / 手动构建还会生成并验证 DMG，不运行 GUI 或真机检查。

## 参与贡献

1. Fork 仓库并创建分支。
2. 完成改动后运行上面的核心质量检查。
3. 保持前端模块的 `// @ts-check`，纯逻辑优先抽成可直接测试的模块。
4. 新增设备型号或固件前，用实机样本确认 HID 字节布局与量程。

测试新增遵循“测试与回归边界”规则；不要为普通 UI 或功能表面变化新增独立测试、设计文档或 CI job。
