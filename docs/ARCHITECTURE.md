← 返回 [README](../README.md)

# 技术架构

本文描述 WITRN-RS 的内部结构。使用说明见 [使用指南](USAGE.md)，构建方式见 [开发与构建](DEVELOPMENT.md)。

- [仓库布局](#仓库布局)
- [后端](#后端)
- [协议库](#协议库)
- [前端](#前端)
- [数据流](#数据流)
- [HID 报文布局](#hid-报文布局)
- [测试](#测试)
- [安全边界](#安全边界)

## 仓库布局

Cargo workspace，三个成员 + 一个不经打包器的前端目录。

```
WITRN-RS/
├── src-tauri/            Tauri v2 应用（后端）
│   ├── src/lib.rs        应用状态、Tauri 命令、HID 读线程与 IPC 发射线程
│   ├── src/pd_capture.rs USB-PD 捕获会话（seq / generation / 按需解码）
│   ├── src/usb_port.rs   分平台 USB 拓扑解析
│   ├── capabilities/     Tauri ACL 能力声明
│   └── tauri.conf.json   窗口、CSP、打包配置
├── crates/
│   ├── usbpd-parser/     USB-PD 报文解码库
│   └── witrn-hid/        WITRN HID 设备封装
├── src/                  前端（原生 ES Modules，即 frontendDist）
├── test/                 前端单元测试（node --test）
├── temperature-example/  外部温度服务 Python 示例
└── docs/                 本文档目录
```

工作区在 `Cargo.toml` 里统一了 `version`、`edition = 2021`、`rust-version = 1.75` 与公共依赖（`serde`、`serde_json`、`hidapi 2.6`、`chrono 0.4`）。

## 后端

### `src-tauri/src/lib.rs`

承载应用状态与全部 Tauri 命令。共享状态的设计原则是**只在必要处加锁**：

- `sample_rate: Arc<AtomicU64>` —— HID 读循环每次迭代都要读采样率，用原子量避免每帧取一次锁。
- 其余共享状态用 `Arc<Mutex<...>>`。

### 线程模型

每个设备连接持有**两个**后台线程，生产者与消费者分离：

```
HID 读线程 ──── channel ────> IPC 发射线程 ──── emit ────> WebView
 只解码，不 emit                合并 / 转发
```

- **HID 读线程** —— 阻塞读 HID 报告，解码校验后写入通道。PD 事件在通道满时进入最多 256 条的 pending，循环下次先排空再读。它不接触 Tauri 的 `emit`，因此 IPC 的抖动不会反压到读取节奏。
- **IPC 发射线程** —— 把 PD 报文按约 8 ms 一帧合并为 `pd-data-batch` 事件；`device-data` 已在读侧按采样率节流，发射侧原样转发不再合并。发送端 drop 时先排空残留再发 `device-disconnected`。

`BackgroundTask::stop()` 先置停止标志再 `join`，且**顺序固定为先生产者后消费者** —— 反过来会让读线程写入一个没人消费的通道。

`shutdown` 命令标注 `#[tauri::command(async)]`，这样它不会在主线程上 join 那些正在 `emit` 的工作线程（否则互相等待会死锁）。停完线程后 `destroy` 主窗口，而不是 `close` —— Tauri v2 的 `close()` 会重新派发 `close-requested`，造成退出回环。

退出前必须先「消费完并 ACK 末包」，这条校验只在 `shutdown` 上；一旦流进入终态（`seq` 空洞、背压超限、屏障超时），`fail()` 已经把生产端 drain 停掉，屏障保护的样本不可能再出现，此时继续坚持校验只会让**断开 / 重连 / 退出永久全部失败**。前端因此改走 `abandon_device_stream`：它只接受「已停止 + 线程已 join + 已有末包回执 + 同 generation」的会话并退休该槽位，**且不写 `consumed`**，所以空洞依旧算未消费。`shutdown` 的谓词一字未改，放宽只发生在这条显式路径上。

### Tauri 命令

| 命令 | 作用 |
| --- | --- |
| `enumerate_devices` | 枚举厂商 VID 下的全部 HID 接口 |
| `connect_device_by_path` | 按 HID 路径连接（前端实际使用的入口） |
| `disconnect_device` | 断开并停止该连接的后台线程 |
| `get_current_device_info` | 返回当前连接的设备信息 |
| `set_sample_rate` | 设置采样间隔，接受 10 – 60000 ms |
| `set_pd_capture_enabled` | 开关 PD 报文采集 |
| `pd_log_clear` | 清空 PD 日志，返回新的 generation |
| `pd_log_after` | 增量拉取 `seq` 大于给定值的报文 |
| `pd_log_replace` | 用导入的报文替换日志，并盖上新 generation |
| `decode_pd_at` | 按 `seq` 单帧解码，O(1)，用于点击某行时才展开详情 |
| `drain_device_stream` | 停止该连接的后台线程并取回末包回执（幂等，可重复调用） |
| `abandon_device_stream` | 退休一个终态会话，让断开 / 重连 / 退出重新可达；不改写 `consumed` |
| `connect_temp_service` / `disconnect_temp_service` | 外部 TCP 温度源 |
| `shutdown` | 停止全部后台线程后销毁主窗口 |

### `src-tauri/src/pd_capture.rs`

PD 日志是一个只追加的 `Vec`，**`seq` 就是下标**，因此 `decode_pd_at` 是 O(1) 查找而不是线性扫描。原始帧被保留下来，详情面板要看哪一帧才解码哪一帧，避免为所有报文预先构建解码树。

- `generation` —— 每次清空或导入替换都递增。前端拿到的事件带着 generation，因此**导入的历史捕获不会和实时流串号**。
- 断开连接产生的分隔行只出现在返回的事件流里，不占用 `seq`。
- `PD_LOG_HARD_CAP = 1_000_000` 是硬上限；前端 `PD_SOFT_CAP = 500_000` 时弹出提示。

### `src-tauri/src/usb_port.rs`

把 HID 路径反解成 USB 拓扑端口（如 `4-4`），用于在设备名里区分插在不同口上的同型号仪表。三套实现：

- **Windows** —— `CM_Get_DevNode_PropertyW` + `DEVPKEY_Device_LocationPaths`，解析 `PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(4)#USB(4)` 形式的字符串。
- **Linux** —— 取 `hidraw*` 名，`canonicalize` `/sys/class/hidraw/<name>/device`，逐级向上读 `devpath` 拼出端口路径。纯只读 sysfs 访问，不需要特殊权限（与打开 `/dev/hidrawN` 不同）。
- **macOS** —— 非独占方式打开设备读 `get_location_id`。

其他平台返回 `None`，设备名退化为不带端口后缀的形式。

> 维简硬件的 USB 序列号是**生产批次日期**而非单机编号，同批次的两台仪表序列号相同。枚举时先按 USB 端口分组，再叠加序列号，以便标题栏区分插在不同口上的同型号仪表。

## 协议库

两个 crate 都不依赖 Tauri，可被其他 Rust 项目直接引用；均为 `publish = false`，仅在本工作区内使用。它们是 [JohnScotttt](https://github.com/JohnScotttt) 的 Python 实现的 Rust 移植，许可为 LGPL-3.0-or-later。

### `crates/usbpd-parser`

USB-PD 报文解码，约 6,300 行 / 102 个测试。按报文结构分模块：`header`、`data_msg`、`ext_msg`、`pdo`、`rdo`、`vdo`、`crc`、`context`、`render`。

- 覆盖控制报文、数据报文、扩展报文，以及 Hard Reset / Cable Reset（SOP 字节 32 步编码）。
- 识别 Structured VDM 2.1。
- 解析结果是一棵带字段名、原始位范围和渲染文本的树，前端直接用来渲染详情面板。
- Feature `vendor-ids`（默认开启）内嵌 USB-IF 厂商表（13,542 条，约 500 KB），用于把 VID 显示成厂商名。
- Feature `serde`（默认开启）提供序列化。

### `crates/witrn-hid`

WITRN HID 设备封装。`device.rs` 负责打开与读取，`general.rs` 负责解码测量帧。

`decode_general_sample` 返回的 `GeneralSample`：

| 字段 | 类型 | 单位 |
| --- | --- | --- |
| `voltage` | `f32` | V |
| `current` | `f32` | A |
| `power` | `f32` | W（由 `voltage × current` 计算，不是读出来的） |
| `dp` / `dn` | `f32` | V |
| `cc1` / `cc2` | `f32` | V |
| `temperature` | `Option<f32>` | °C，字段不可信时为 `None` |
| `ah` | `f32` | Ah（仪表内部累加器） |
| `wh` | `f32` | Wh（仪表内部累加器） |

> 仪表自己的 `ah` / `wh` 累加器会一路转发到前端，但**界面上的「累计能量 / 累计容量」并不使用它们** —— 前端对采样点自行积分，这样才能实现「暂停期间不计入积分」和「仅统计选中范围」，并由 `一键重置` 统一归零。
>
> 积分跳过「相邻点间隔过大」的空档（休眠 / NTP 前跳 / 漏采），阈值是 `max(2 s, 8 × 标称采样间隔)`，与 x 轴 `nextRecordingX` 放行点数用的是同一个倍数 —— 固定 2 秒会让 5 s / 10 s 档的每一步都被当成空档，能量恒为 `0.0000`。标称间隔的来源依次是：原生流的 `rate_ms`、导入 CSV 的 `SampTime(ms)`（旧文件从相对秒反推中位数）、`settings.sampleRate`；三者都拿不到时阈值退回 2 秒。

## 前端

`src/` 就是 `tauri.conf.json` 里的 `frontendDist`，**没有打包器、没有构建步骤、没有 dev server**。文件按原样交给 WebView，改完刷新即可。`withGlobalTauri: true`，所以前端通过 `window.__TAURI__` 调用后端，不需要 `@tauri-apps/api` npm 包；类型在 `src/global.d.ts` 里手写声明，全部模块开启 `// @ts-check`。

按职责分组：

| 分组 | 模块 | 职责 |
| --- | --- | --- |
| 装配 | `app.js`、`shell.js`、`state.js` | 入口与事件绑定、视图注册表与 Tab 切换、共享状态与类型定义 |
| 图表 | `chart.js`、`chart-buckets.js`、`chart-window.js`、`theme.js` | uPlot 初始化与渲染调度、可见窗口像素桶、时间窗缩放纯函数、把 CSS 设计令牌桥接给 canvas |
| 数据 | `data.js`、`measurement.js`、`csv.js` | 采集与统计、纯函数的时间解析与能量积分、CSV 导入导出 |
| PD | `pd-model.js`、`views/pd.js` | 纯函数的报文摘要与过滤、PD 工作区视图 |
| 设备 | `device.js`、`temperature.js` | 连接管理、设置页 VID/PID/SN、TCP 温度源 |
| 设置 | `settings.js`、`views/settings-view.js`、`ui-scale.js`、`theme-boot.js` | 防抖持久化、设置页、50–200% 缩放、避免首帧闪白的主题引导 |
| 界面原语 | `ui/` | `dialog` `toast` `menu` `flyout` `tabbar` `controlbar` `windowcontrols` |
| 样式 | `styles/` | `tokens`（三层设计令牌）→ `base` → `components` → `app` → `views` → `compact`（窄窗分级布局） |
| 依赖 | `vendor/` | uPlot 与 Store 插件 shim，运行时无 CDN 请求 |

`measurement.js`、`pd-model.js` 与 `chart-window.js` 是刻意抽出来的**纯函数模块** —— 不接触 DOM 也不接触 Tauri，因此可以在 Node 里直接单元测试。

### 图表渲染

数据以列式数组存储（`F64Col`），不是 `{x, y}` 对象数组。可见数据量超过 1 倍视口宽度后切换为增量 min/max 像素桶：每个像素列只保留极值，但**完整数据仍在列里**，悬停时二分回查原始采样点，读到的是真实值。主图 X 窗是会话态的时间窗口（`full` / `follow` / `frozen`），录制中右沿可贴着最新数据滑动。uPlot 侧设 `series auto: false`，避免它每帧全量扫描 min/max。

## 数据流

1. 前端调 `enumerate_devices` 扫描厂商 VID `0x0716` 下的设备；同一物理设备有多个 HID 接口时，后端优先选择厂商自定义 Usage Page。
2. 前端调 `connect_device_by_path` 连接选中的接口。
3. 后端启动该连接独享的 HID 读线程与 IPC 发射线程，解码并校验 HID 报告。
4. 合法数据经事件系统推送：测量帧走 `device-data`（已按采样率节流），PD 报文走 `pd-data-batch`（约 8 ms 合并一帧）。
5. 前端更新读数卡、uPlot 图表、统计，以及记录区间内的 Wh / mAh 积分。

## HID 报文布局

报告固定 **64 字节**，第 0 字节为报告类型；`0xFF` 是测量帧。数值均为**小端**。

| 偏移 | 类型 | 字段 | 校验 |
| --- | --- | --- | --- |
| 0 | `u8` | 报告类型，必须为 `0xFF` | 不符则拒帧 |
| 14–17 | `f32` | 累计容量 Ah（仪表累加器） | 非有限值拒帧 |
| 18–21 | `f32` | 累计能量 Wh（仪表累加器） | 非有限值拒帧 |
| 26–29 | `u32` | 运行时长（秒） | — |
| 30–33 | `f32` | D+ 电压 | — |
| 34–37 | `f32` | D− 电压 | — |
| 42–45 | `f32` | 温度 (°C) | 超出 −40 – 150 视为无温度 |
| 46–49 | `f32` | 总线电压 (V) | 超出 0 – 60 拒帧 |
| 50–53 | `f32` | 总线电流 (A) | 超出 −20 – 20 拒帧 |
| 55 | `u8` | CC1 电压，值 ÷ 10 | — |
| 56 | `u8` | CC2 电压，值 ÷ 10 | — |

功率不在报文里，由 `voltage × current` 计算。

几点重要说明：

- **电流范围放宽到 ±20 A**（K2 标称 ±10 A）是有意的：略微过冲或量化误差不应该让整帧被丢掉。
- **温度越界只按「无温度」处理，不丢整帧** —— 该偏移只在部分型号上验证过，误判温度不该连带丢掉可信的电压电流。
- **目前未实现协议校验和验证。** 新增设备型号或固件前，应先用实机样本确认字节布局与量程。

## 测试

### 前端 —— `test/`

用 Node 内置测试运行器（`node --test`），只覆盖不依赖 DOM 与 Tauri 的纯逻辑，以及跨文件的契约断言：

```
chart-buckets  chart-columns  chart-window  ids       ingest      measurement
pd-batch       pd-capture-file          pd-capture-state
pd-clear-linkage         pd-model       pd-recording
recording      security-csp   theme     ui-scale    utils
version-sync   temp-disconnect          settings-persistence
```

其中有四个是**契约测试** —— 它们不测某个函数的行为，而是断言分散在多个文件里的事实必须彼此一致：

- **`ids.test.js`** —— DOM 契约。从 JS 里提取每一个 `getElementById` 的字面量，断言该 id 在 `index.html` 中**恰好出现一次**。布局重构时丢掉某个控件会立刻被它抓住。
- **`version-sync.test.js`** —— 版本契约。断言 `package.json`、`Cargo.toml` 的 `[workspace.package]`、`src-tauri/tauri.conf.json` 三处版本号一致，格式为 `X.Y.Z`，且三个成员 crate 仍是 `version.workspace = true`（否则会冒出第四、第五个真相来源）。
- **`security-csp.test.js`** —— 安全契约。断言 dialog 能力只有 `allow-open` / `allow-save`，CSP 的 `script-src` / `style-src` 不含 `'unsafe-inline'`。
- **`pd-capture-file.test.js`** —— PD 捕获文件的版本信封与 v1 兼容路径。

其余是纯逻辑测试，例如：

- **`chart-window.test.js`** —— 滚轮缩放钳位、follow 保 duration、frozen 窗口不随 `lastX` 漂移。
- **`measurement.test.js`** —— 相对时间解析（含 `D.hh:mm:ss.ms` 天数前缀）、相邻区间能量积分（跳过随标称采样间隔定标的空档）。
- **`pd-model.test.js`** —— 报文摘要提取（SOP / 角色 / 速览）、GoodCRC 过滤、缓冲回绕。

### Rust —— 171 个 `#[test]`

| 位置 | 数量 |
| --- | --- |
| `crates/usbpd-parser`（12 个模块 + `tests/conversation.rs` 完整会话回放） | 104 |
| `crates/witrn-hid`（`device.rs`、`general.rs`） | 23 |
| `src-tauri`（`lib.rs`、`pd_capture.rs`、`usb_port.rs`） | 44 |

另有 17 个文档测试（`crates/usbpd-parser` 13 个、`crates/witrn-hid` 4 个），随 `cargo test --workspace` 一并运行。

硬件相关路径（真实 HID 设备、TCP 温度服务）未接入自动化测试。

CI 的 Rust 步骤都是工作区范围（`--all` / `--workspace`），三个包全部受 fmt / clippy / test 检查；另有一个 `crate-features` job 专门跑两个协议 crate 的非默认特性组合。详见 [开发与构建 · CI](DEVELOPMENT.md#-ci-门禁)。

## 安全边界

- **CSP** —— WebView 启用内容安全策略，`img-src` 只允许 `self`、`asset:` 与 `blob:`，`connect-src` 只允许 `self` 与 IPC。`script-src` / `style-src` 均为 `'self'`，不含 `'unsafe-inline'`（Tauri 编译期会给本地脚本补 hash、给样式补 nonce）。
- **对话框能力最小化** —— `capabilities/default.json` 只授予 `dialog:allow-open` 与 `dialog:allow-save`。应用内确认框走 `<dialog>`，不授权原生 message/ask。
- **文件系统能力最小化** —— 只授予 `fs:default` 与 `fs:allow-write-text-file`，不授予主目录递归写权限。文件选择器保留 Tauri 原生实现，因为 v2 通过对话框选择才会在运行时授予所选路径的 fs scope；换成应用内实现会直接让 `writeTextFile` / `readTextFile` 失去权限。
- **窗口能力** —— 因为使用无边框自定义标题栏，需要一组 `core:window:allow-*` 权限（拖动、缩放、最大化等）。
- **无网络依赖** —— 前端运行依赖全部 vendor 到 `src/vendor/`，运行时不从 CDN 加载脚本或样式。唯一的网络行为是用户主动配置的外部温度服务（出站 TCP）。
