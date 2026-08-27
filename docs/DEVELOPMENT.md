← 返回 [README](../README.md)

# 开发与构建

- [环境要求](#环境要求)
- [构建与运行](#构建与运行)
- [质量检查](#质量检查)
- [CI 门禁](#-ci-门禁)
- [Linux 自行编译](#-linux-自行编译)
- [参与贡献](#参与贡献)

## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Rust | 1.75+ | 工作区 `rust-version`；建议用最新稳定版 |
| Tauri CLI | v2 | `cargo install tauri-cli --version "^2"` |
| Windows | 10 / 11 | 当前的开发与验证平台 |
| MSVC Build Tools | — | Windows 上编译 Rust 需要 |
| Node.js | 20+ | **仅**用于 lint / typecheck / test |

### 关于 Node 与包管理器

这两点容易踩坑，先说清楚：

- **本项目用 npm**，不是 pnpm。仓库里提交的是 `package-lock.json`，CI 用 `npm ci`。
- **Node 完全不参与 Tauri 构建。** `tauri.conf.json` 里只有 `frontendDist: "../src"`，没有 `beforeDevCommand` / `beforeBuildCommand`，前端是不经打包器的原生 ES Modules，按原样交给 WebView。

因此：

- 构建命令是 **`cargo tauri dev` / `cargo tauri build`**，不是 `npm run tauri dev`。
- **没有** `npm run dev` 和 `npm run build` 这两个脚本。`package.json` 只有四个脚本：`test`、`typecheck`、`lint`、`format`。
- 没有 HMR / dev server。改前端文件后刷新 WebView 即可生效。
- 不装 Node 也能完整构建应用，只是跑不了质量检查。

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

`bundle.targets` 设为 `"all"`，即在当前主机上生成该平台所有可用格式：Windows 下是 **MSI + NSIS**，Linux 下是 deb / rpm / AppImage，macOS 下是 app / dmg。产物位于 `src-tauri/target/release/bundle/`。

> 发布页面提供的安装包由维护者在 Windows 上手动构建上传 —— CI **不打包**任何产物，只做编译与测试。

## 发布流程

版本号写在**三个文件**里，没有工具自动同步：

| 文件 | 位置 |
| --- | --- |
| `package.json` | `"version"` |
| `Cargo.toml` | `[workspace.package]` 的 `version`（三个成员 crate 通过 `version.workspace = true` 继承） |
| `src-tauri/tauri.conf.json` | `"version"` |

漏改一处不会有任何构建或测试报错 —— 装出来的包和源码对不上，但一切看起来都正常。所以这条不变量由 **`test/version-sync.test.js`** 守着：它断言三处一致、格式为 `X.Y.Z`，且成员 crate 仍在继承而不是各写各的。该测试随 `npm test` 运行，因此 CI 每次 push / PR 都会检查。

发版步骤：

1. 三处版本号一起改。
2. 在 `CHANGELOG.md` 顶部加该版本的条目。
3. `npm test` —— 版本契约测试会确认三处已同步。
4. 提交，然后打 tag：`git tag v0.2.0 && git push origin v0.2.0`。
5. 在 Windows 上 `cargo tauri build`，把 `src-tauri/target/release/bundle/` 下的 MSI 与 NSIS 安装包上传到 Release 页面。

> **别漏掉第 4 步。** 历史上 `v0.1.3` 有 CHANGELOG 条目却从未打 tag，`v0.2.0` 也一样 —— 结果 README 的 release 徽标一直显示落后的 `v0.1.5`。
>
> tag 推上去时 CI 会额外跑一步 `Verify tag matches manifest version`，确认 tag 名与清单版本一致（`v0.2.0` ↔ `0.2.0`），对不上直接失败。这拦得住"tag 打错版本"，但拦不住"根本没打 tag"—— 后者只能靠这份清单。

## 质量检查

跑一遍与 CI 完全相同的检查：

```bash
npm ci
npm test                    # node --test，17 个文件 / 97 个用例
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


## 🔁 CI 门禁

`.github/workflows/ci.yml` 在**每次 push 和 PR** 时运行（无分支或路径过滤），两个 job：

| Job | 平台 | 内容 |
| --- | --- | --- |
| `validate` | `ubuntu-latest` | 装系统依赖 → `npm ci` → `npm test` → `typecheck` → `lint` → `cargo fmt --check --all` → `cargo clippy --workspace -D warnings` → `cargo test --workspace` |
| `backend-other-platforms` | `windows-latest` | `cargo test --workspace` |
| | `macos-latest` | `cargo check --workspace --all-targets` |
| `crate-features` | `ubuntu-latest` | 对两个协议 crate 的 6 组非默认特性组合逐个跑 clippy 与 test |

Rust 步骤都是工作区范围，因此 `src-tauri` 与两个协议 crate 一并受检。三个 job 都启用了 `Swatinem/rust-cache@v2` 缓存依赖编译产物。

`on: push` 没有分支或路径过滤，因此**推 tag 也会触发 CI**。`validate` 里有一步 `Verify tag matches manifest version` 只在 `refs/tags/v*` 上运行，断言 tag 名与 `package.json` 的版本号一致。

CI **不做**的事：不构建安装包、不发布 Release。发版是手动流程，见 [发布流程](#发布流程)。

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

产物在 `src-tauri/target/release/bundle/`（deb / rpm / AppImage）。

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
