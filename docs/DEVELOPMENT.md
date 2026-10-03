← 返回 [README](../README.md)

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

## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作区 `rust-version` |
| Tauri CLI | v2 | `cargo install tauri-cli --version "^2"` |
| Windows | 10 / 11 | 当前开发与验证平台 |
| macOS | 12+ | 可自行编译 |
| Node.js | 20+ | lint / typecheck / test / 前端产物 |

项目使用 npm，提交 `package-lock.json`，CI 使用 `npm ci`。前端是原生 ES Modules，`frontendDist` 指向构建生成的 `out/`；Node 不参与 Rust 编译，但 `npm run build` 必须先于 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`。改动 `src/` 后先重建 `out/`，再重新链接 Rust 二进制。

## 构建与运行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
cargo install tauri-cli --version "^2"
npm ci
npm run build
cargo tauri dev
cargo tauri build
```

发布产物位于 `target/release/bundle/`。CI 不打包安装程序，发布包由维护者在目标平台手动构建上传。

## 发布流程

开发时统一使用以下命令设置版本号，无需逐个文件手改：

```bash
npm run version:set -- 0.2.2
```

将 `0.2.2` 换成目标版本即可。命令接受不含前导零的 `X.Y.Z`，先校验所有文件，再同步以下位置；重复设置同一版本不会重复写入，也不会创建 Git 提交或 tag、更新依赖或修改更新日志：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 顶层与根包 `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 所有工作区成员包的 `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust 成员 crate 继续通过 `version.workspace = true` 继承版本；关于页从 Tauri 读取版本，开发展示工具从 `package.json` 读取版本。更新后重新构建，才能让可执行文件和安装包使用新版本。

`test/version-sync.test.js` 会检查清单与锁文件一致、语义版本格式、workspace 继承关系、统一更新命令和 macOS private API 配置。正式发布时整理 `CHANGELOG.md`，将对应的 `Unreleased` 内容归入新版本。发布前运行 `npm test`，提交后再打 tag，并在 Windows 上执行 `cargo tauri build` 生成安装包。

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

截图命令使用 Chromium、Windows 风格、1280×800 CSS 视口、2 倍像素密度及 100% 界面缩放，生成 2560×1600 PNG。默认使用 POWER-Z、本机温度源与相同的 120 秒模拟数据，先冻结虚拟时间，再等待实际图表、报文详情、字体与控件渲染完成。输出为 `docs/screenshots/{dark,light}-{record,pd,trigger,settings}.png`，覆盖 README 的 8 张展示图。

可以只截取指定页面、主题或更改输出目录：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--theme` 支持 `light,dark`，默认按浅色、深色顺序生成；`--page` 支持 `record,pd,trigger,settings`。输出目录相对于仓库根目录，也可使用绝对路径。修改 `tools/showcase/scenario.js` 可以调整虚拟设备信息、随机种子、充电曲线、握手时刻及 PDO / 协议检测结果。`bridge.js` 实现 Tauri 命令、事件、录制段、ACK、内存设置与文件句柄；未实现的调用会明确报错。CSV / PD 导出通过浏览器下载，CSV 导入通过浏览器文件选择器；PD 导入仅支持包含已固化样例原始报文的文件，任意真机报文解码仍应使用原生软件。

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

CI 不运行浏览器验收、硬件长跑或功能表面回归，也不构建安装包或发布 Release。开发展示工具仅用于按需预览和生成文档图片，不承担浏览器验收或 CI 门禁；新增功能不应顺手增加专用 workflow、job 或回归 harness。

## Linux 自行编译

Linux 构建与运行未持续接入真实设备验证。Debian / Ubuntu 依赖：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
cargo tauri build
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

需要 Xcode Command Line Tools、Rust 稳定版和 Tauri CLI v2：

```bash
npm ci
npm run build
cargo tauri build
```

macOS private API 的 Cargo feature 与 Tauri 配置必须保持一致；CI 在 macOS 上只做 workspace check，不运行 GUI 或真机检查。

## 参与贡献

1. Fork 仓库并创建分支。
2. 完成改动后运行上面的核心质量检查。
3. 保持前端模块的 `// @ts-check`，纯逻辑优先抽成可直接测试的模块。
4. 新增设备型号或固件前，用实机样本确认 HID 字节布局与量程。

测试新增遵循“测试与回归边界”规则；不要为普通 UI 或功能表面变化新增独立测试、设计文档或 CI job。
