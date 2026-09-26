← 返回 [README](../README.md)

# WITRN-RS macOS ARM64 构建记录

自行编译步骤的摘要见 [开发与构建 · macOS 自行编译](DEVELOPMENT.md#-macos-自行编译)。下文是一次 Apple Silicon 上的完整打包记录。

## 基本信息

- 上游仓库：[KHWLGH/WITRN-RS](https://github.com/KHWLGH/WITRN-RS)
- 版本：`v0.2.1`
- 固定提交：`72ebad4fe3743a0fbd475d8e3d45055504ce60fd`
- 本地分支：`macos-arm64`
- 许可证：保留上游 GPLv3（未修改）
- 构建机器：Apple Silicon `arm64`
- 系统：macOS `15.7.7`（Build `24G720`）
- Rust：`rustc 1.98.0` / `cargo 1.98.0`
- Tauri CLI：`2.11.4`
- Node.js / npm：`v24.16.0` / `11.13.0`

## 本次 macOS 修复

源码本身已经包含 macOS HID 分支（非独占打开）和自绘窗口控制，不需要重写协议或前端。实际启动测试发现，`tauri-plugin-decorum` 在 macOS 创建窗口时仍会进入 Cocoa 交通灯定位器，并因缺少预期的原生 superview 触发空指针崩溃。因此只做了以下平台限定修改：

1. 在 `src-tauri/Cargo.toml` 启用 Tauri 的 `macos-private-api`，并在 `src-tauri/tauri.conf.json` 与 `src-tauri/tauri.macos.conf.json` 同时设置 `app.macOSPrivateApi: true`。`cargo test` / `clippy` 只读主配置、不合并平台 overlay，两边必须一致，否则 Linux/Windows CI 会在 tauri-build 的 allowlist 校验处失败。
2. 在 `src-tauri/src/lib.rs` 中仅对 macOS 跳过 `tauri-plugin-decorum` 初始化。Windows/Linux 路径保持原有初始化和行为；Windows 的 overlay titlebar 代码仍只在 Windows 编译。

现有 Tauri commands、事件名、事件载荷、设置结构、USB-PD 协议、采样算法和 CSV/PD 文件格式均未调整。

## 构建命令

在仓库根目录执行：

```bash
npm ci
cargo tauri build
```

本次 release 编译和 `.app` 打包成功。第一次 DMG 运行在锁屏桌面上，Tauri 的 Finder AppleScript 美化步骤失败；没有改变全局代理或源码行为，改用 Tauri 自带脚本的无 Finder 美化模式重新封装：

```bash
cd target/release/bundle/macos
./../dmg/bundle_dmg.sh --skip-jenkins \
  --volname WITRN-RS \
  --icon WITRN-RS.app 200 200 \
  --app-drop-link 420 200 \
  --window-size 500 350 \
  --hide-extension WITRN-RS.app \
  --volicon ../dmg/icon.icns \
  WITRN-RS_0.2.1_aarch64.dmg WITRN-RS.app
mv WITRN-RS_0.2.1_aarch64.dmg ../dmg/WITRN-RS_0.2.1_aarch64.dmg
```

为使本地严格签名检查覆盖整个 app bundle，构建后的应用使用了不含开发者身份的 ad-hoc 签名（不是 Developer ID）：

```bash
codesign --force --deep --sign - --timestamp=none \
  target/release/bundle/macos/WITRN-RS.app
```

如果源码或 app 内容改变，应先重新构建、签名，再重新生成 DMG。

## 产物

- App：`target/release/bundle/macos/WITRN-RS.app`
- DMG：`target/release/bundle/dmg/WITRN-RS_0.2.1_aarch64.dmg`
- 产物大小：App 约 `15M`；DMG `5,357,026` bytes
- DMG SHA-256：`38439f97f4b2b74e38b931e919976959b51b73af46dcc1d0e4015f31379aff82`
- App 主二进制：`Contents/MacOS/witrn-rs`
- 主二进制 SHA-256：`a5030b0e54d5aeef73bfb5b2df29b3110b4622bb80278be3df7364bba2c52767`
- `lipo -info`：确认是纯 `arm64`，没有 Intel 或 universal slice。
- `codesign --verify --deep --strict`：通过；签名类型为本机 ad-hoc，未设置 Team ID。
- `hdiutil verify`：通过，DMG checksum valid。
- DMG 已只读挂载检查，内含 `WITRN-RS.app`、`Applications` 拖放链接和图标文件；从挂载卷直接启动主二进制后进程保持运行，并已正常停止、卸载。

## 自动检查结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 通过，109 passed / 0 failed |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，Biome 检查 61 个文件 |
| `cargo fmt --check --all` | 通过 |
| `cargo clippy --workspace --all-targets --offline -- -D warnings` | 通过；仅有依赖 `block v0.1.6` 的 future-incompatibility 提示 |
| `cargo test --workspace --offline` | 通过，166 个测试/文档测试通过 |
| `git diff --check` | 通过 |

## 安装与安全边界

本构建只针对这台 Apple Silicon Mac 自用：

1. 双击 DMG。
2. 将 `WITRN-RS.app` 拖到 Applications（或其他个人目录）。本次没有替用户写入 `/Applications`。
3. 首次启动如果被 Gatekeeper 拦截，可在 Finder 中按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”允许本次打开。

本包没有 Developer ID 签名、Apple 公证或通用架构，因此不能把 Gatekeeper 放行状态当作已完成的发布签名，也不承诺在其他 Mac 上免提示运行。DMG 使用 `--skip-jenkins` 生成，功能和内容完整，但没有 Finder 窗口背景/图标位置美化。

## GUI 与硬件验收边界

- 已验证：开发版和 DMG 挂载卷中的 release app 均能启动并保持进程运行；DMG 可挂载、可读取、可卸载。
- 尚未验证：主题/中文字体、窗口拖动和缩放、最小化/最大化/关闭确认、设置持久化、文件选择与重启恢复等交互。验收时 Mac 处于锁屏状态，桌面自动化工具无法在不解锁的情况下读取窗口。
- 尚未验证：WITRN 真机连接、VID `0x0716` 枚举、刷新/按路径连接、实时电压电流功率、PD 报文、记录暂停、CSV 导入导出、拔线检测和重新连接。构建机验收期间 `system_profiler SPUSBDataType` 只看到三个空 USB 总线，没有 `0x0716` 设备。

真机验收前请使用可传数据线直连 Mac（先排除 Hub/线材问题），确认系统能看到 WITRN 后再在应用内刷新和连接。只有系统能看到设备而应用仍看不到时，才继续定位 HID 枚举代码。
