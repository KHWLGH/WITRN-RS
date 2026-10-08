← 返回 [README](../README.md)

# 技术架构

本文描述 laPower 的内部结构。使用说明见 [使用指南](USAGE.md)，构建方式见 [开发与构建](DEVELOPMENT.md)。

- [仓库布局](#仓库布局)
- [后端](#后端)
- [协议库](#协议库)
- [前端](#前端)
- [数据流](#数据流)
- [HID 报文布局](#hid-报文布局)
- [测试](#测试)
- [安全边界](#安全边界)

## 仓库布局

Cargo workspace，四个成员 + 一个原生 JavaScript 前端源码目录；发布构建由 esbuild 生成前端产物。

```
laPower/
├── src-tauri/            Tauri v2 应用（后端）
│   ├── src/lib.rs        应用状态、Tauri 命令、HID 读线程与 IPC 发射线程
│   ├── src/pd_capture.rs USB-PD 捕获会话（seq / generation / 按需解码）
│   ├── src/usb_port.rs   分平台 USB 拓扑解析
│   ├── capabilities/     Tauri ACL 能力声明
│   └── tauri.conf.json   窗口、CSP、打包配置
├── crates/
│   ├── usbpd-parser/     USB-PD 报文解码库
│   ├── km003c/            POWER-Z Bulk 协议、AdcQueue 与 CDC 控制
│   └── witrn-hid/        WITRN HID 设备封装
├── src/                  前端源文件（原生 ES Modules）
├── out/                  构建后的 frontendDist（不入库）
├── tools/showcase/       虚拟设备与截图开发工具（不随应用发货）
├── test/                 前端单元测试（node --test）
├── temperature-example/  外部温度服务 Python 示例
└── docs/                 本文档目录
```

工作区在 `Cargo.toml` 里统一了 `version`、`edition = 2021`、`rust-version = 1.85` 与公共依赖（`serde`、`serde_json`、`hidapi 2.6`、`chrono 0.4`）。

## 后端

### `src-tauri/src/lib.rs`

承载应用状态与全部 Tauri 命令。共享状态的设计原则是**只在必要处加锁**：

- `sample_rate: Arc<AtomicU64>` —— HID 读循环每次迭代都要读采样率，用原子量避免每帧取一次锁。
- 其余共享状态用 `Arc<Mutex<...>>`。

### 线程模型

每个设备连接持有读线程与 IPC 发射线程；POWER-Z 另外持有一个 CDC 协议控制线程：

```
HID 读线程 ──── channel ────> IPC 发射线程 ──── emit ────> WebView
 只解码，不 emit                合并 / 转发
                         ↘ POWER-Z CDC 控制线程
```

- **采集读线程** —— WITRN 阻塞读 HID 报告，POWER-Z 读取 Vendor Bulk / AdcQueue；解码、节拍选点后写入容量 4096 的有界通道。PD 事件在通道满时进入最多 256 条的 pending，完整报文仍保留在后端日志。测量样本的未确认量达到 8192 时明确停止采集并报错。
- **IPC 发射线程** —— 测量与 PD 分别发为 `device-data-batch` / `pd-data-batch`。测量按最多 64 点或 `clamp(4 × 采样间隔, 8 ms, 50 ms)` 合批，保留每点的序号、录制段与时间戳；前端消费后通过 ACK 确认。采集停止时先排空残留，再发末包回执与断开事件。

因为采集能否继续取决于前端 ACK，窗口不可见时前端也必须照常运行。macOS 上两件事会破坏这一点，因此分别处理：WKWebView 默认挂起不可见的页面，主窗口配置 `backgroundThrottling: "disabled"`（macOS 14+）；App Nap 会合并整个进程的定时器并降低线程优先级，读线程存活期间持有 `NSProcessInfo` activity（`src-tauri/src/app_nap.rs`）退出 App Nap，并带 `LatencyCritical`：只退出 App Nap 时，最小化窗口下读线程仍偶尔迟醒（实测最大 36 ms），迟到的报告按主机接收时刻打戳后在 10 ms 选择窗口里被合并。读线程收到非零的录制段（`set_recording_segment`）时换成同时阻止系统空闲睡眠的 activity，收到 0（暂停、停止、清空）时换回只退出 App Nap 的那个；先开始新的再结束旧的，切换时不留空档。屏幕熄灭、合盖和手动睡眠不受影响。Windows 的 WebView2 最小化时仍在运行，不受这两项影响。

`BackgroundTask::stop()` 先置停止标志再 `join`，且**顺序固定为先生产者后消费者** —— 反过来会让读线程写入一个没人消费的通道。

`shutdown` 命令标注 `#[tauri::command(async)]`，这样它不会在主线程上 join 那些正在 `emit` 的工作线程（否则互相等待会死锁）。停完线程后 `destroy` 主窗口，而不是 `close` —— Tauri v2 的 `close()` 会重新派发 `close-requested`，造成退出回环。

退出前必须先「消费完并 ACK 末包」，这条校验只在 `shutdown` 上；一旦流进入终态（`seq` 空洞、背压超限、屏障超时），`fail()` 已经把生产端 drain 停掉，屏障保护的样本不可能再出现，此时继续坚持校验只会让**断开 / 重连 / 退出永久全部失败**。前端因此改走 `abandon_device_stream`：它只接受「已停止 + 线程已 join + 已有末包回执 + 同 generation」的会话并退休该槽位，**且不写 `consumed`**，所以空洞依旧算未消费。`shutdown` 的谓词一字未改，放宽只发生在这条显式路径上。

### Tauri 命令

| 命令 | 作用 |
| --- | --- |
| `enumerate_devices` | 合并 WITRN HID 与 POWER-Z Vendor Bulk 设备枚举 |
| `connect_device_by_path` | 按 HID 路径连接（前端实际使用的入口） |
| `disconnect_device` | 断开并停止该连接的后台线程 |
| `get_current_device_info` | 返回当前连接的设备信息 |
| `set_sample_rate` | 设置采样间隔，接受 1 – 60000 ms；按设备下限钳制 |
| `set_pd_capture_enabled` | 开关 PD 报文采集 |
| `pd_log_clear` | 清空 PD 日志，返回新的 generation |
| `pd_log_after` | 增量拉取 `seq` 大于给定值的报文 |
| `pd_log_replace` | 用导入的报文替换日志，并盖上新 generation |
| `decode_pd_at` | 按 `seq` 单帧解码，O(1)，用于点击某行时才展开详情 |
| `drain_device_stream` | 停止该连接的后台线程并取回末包回执（幂等，可重复调用） |
| `ack_device_stream` | 确认同 generation 中已消费的样本序号 |
| `set_recording_segment` | 在采集源建立录制段边界，同步 PD 跟随状态 |
| `abandon_device_stream` | 退休一个终态会话，让断开 / 重连 / 退出重新可达；不改写 `consumed` |
| `connect_temp_service` / `disconnect_temp_service` | 外部 TCP 温度源 |
| `shutdown` | 停止全部后台线程后销毁主窗口 |
| `km003c_trigger` / `km003c_cancel_trigger` | 执行或取消 POWER-Z 协议控制命令 |

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

三个 crate 都不依赖 Tauri，可被其他 Rust 项目直接引用；均为 `publish = false`，仅在本工作区内使用。工作区公共许可证为 LGPL-3.0-or-later。

### `crates/usbpd-parser`

USB-PD 报文解码。按报文结构分模块：`header`、`data_msg`、`ext_msg`、`pdo`、`rdo`、`vdo`、`crc`、`context`、`render`。

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

### `crates/km003c`

POWER-Z KM003C/KM002C 的 Interface 0 Vendor Bulk 协议与虚拟串口控制。`protocol::auth` 实现
MemoryRead / StreamingAuth 的 AES-128-ECB 包，`protocol::queue` 解析 20 字节 AdcQueue 样本，
`transport::bulk` 负责连接、认证、StartGraph、队列读取与 StopGraph，`trigger` 负责 CDC 文本命令。
1 ms 会话的队列序号由 `src-tauri/src/km003c_session.rs` 展开为单调主机时间，并统计序号空洞。

> 仪表自己的 `ah` / `wh` 累加器会一路转发到前端，但**界面上的「累计能量 / 累计容量」并不使用它们** —— 前端对采样点自行积分，这样才能实现「暂停期间不计入积分」和「仅统计选中范围」，并由 `一键重置` 统一归零。
>
> 积分跳过「相邻点间隔过大」的空档（休眠 / NTP 前跳 / 漏采），阈值是 `max(2 s, 8 × 标称采样间隔)`，与 x 轴 `nextRecordingX` 放行点数用的是同一个倍数 —— 固定 2 秒会让 5 s / 10 s 档的每一步都被当成空档，能量恒为 `0.0000`。标称间隔的来源依次是：原生流的 `rate_ms`、导入 CSV 的 `SampTime(ms)`（旧文件从相对秒反推中位数）、`settings.sampleRate`；三者都拿不到时阈值退回 2 秒。

## 前端

`src/` 是前端源码，`tauri.conf.json` 的 `frontendDist` 指向构建生成的 `out/`。`npm run build` 合并样式并保留原生 JS 模块；`npm run build:dist` 进一步分别合并应用入口和 Worker。未配置 `devUrl`，改动源码后需重建前端并重新链接 Rust 二进制；按需浏览器预览由独立的 `tools/showcase/` 提供。`withGlobalTauri: true`，前端通过 `window.__TAURI__` 调用后端，类型在 `src/global.d.ts` 中声明，模块开启 `// @ts-check`。

关于页图标在构建时从 `src-tauri/icons/128x128@2x.png` 复制到 `out/assets/app-icon.png`，与桌面图标使用同一份资源；开发展示服务器也直接读取该文件。

按职责分组：

| 分组 | 模块 | 职责 |
| --- | --- | --- |
| 装配 | `app.js`、`shell.js`、`state.js` | 入口与事件绑定、视图注册表与 Tab 切换、共享状态与类型定义 |
| 图表 | `chart.js`、`chart-buckets.js`、`chart-extrema.js`、`chart-pacing.js`、`chart-window.js`、`performance-diagnostics.js`、`theme.js` | uPlot 渲染调度、窗口极值桶与历史索引、自动刷新和绘制反馈、时间窗缩放、性能诊断与 Canvas 主题 |
| 数据 | `data.js`、`measurement.js`、`csv.js` | 采集与统计、纯函数的时间解析与能量积分、CSV 导入导出 |
| PD | `pd-model.js`、`views/pd.js` | 纯函数的报文摘要与过滤、PD 工作区视图 |
| 设备 | `device.js`、`temperature.js` | 连接管理、设置页 VID/PID/SN、TCP 温度源 |
| 设置 | `settings.js`、`views/settings-view.js`、`ui-scale.js`、`theme-boot.js` | 防抖持久化、设置页、50–200% 缩放、默认跟随系统并同步首帧主题 |
| 界面原语 | `ui/` | `dialog` `toast` `menu` `flyout` `tabbar` `controlbar` `windowcontrols` |
| 样式 | `styles/` | `tokens`（三层设计令牌）→ `base` → `components` → `app` → `views` → `compact`（窄窗分级布局） |
| 依赖 | `vendor/` | uPlot 与 Store 插件 shim，运行时无 CDN 请求 |

`measurement.js`、`pd-model.js` 与 `chart-window.js` 是刻意抽出来的**纯函数模块** —— 不接触 DOM 也不接触 Tauri，因此可以在 Node 里直接单元测试。

### 图表渲染

数据以列式数组存储（`F64Col`），不是 `{x, y}` 对象数组。密集窗口切换为增量 min/max 像素桶，但**完整数据仍在列里**，悬停时二分回查原始采样点，读到的是真实值。录制按 CSS 宽度调整预算，回看按实际画布像素宽度分桶；点数不超过对应分辨率时提交原始点及裁剪邻点。画布后备宽度与 CSS 宽度的比值决定实际 DPI，避免系统缩放改变而画布未更新时误算密度。主图 X 窗是会话态的时间窗口（`full` / `follow` / `frozen`），录制中右沿可贴着最新数据滑动。uPlot 侧设 `series auto: false`，避免它每帧全量扫描 min/max。

`ExactExtremaIndex` 按已完成的数据前缀复用，较早或较短的窗口只查询索引，追加样本补建尾部；清空、替换及修改原始列使索引失效。窗口变化取消过期投影，但保留已完成的索引。已有索引的投影每步最多查询 32 个桶，先在约 4 ms 内尝试完成并提交；未完成的查询、原始扫描和历史冷建使用约 1.5 ms 的协作片，只有完整投影可以发布。

绘图请求区分 `live`、`interaction` 和 `maintenance`，同帧合并到最新窗口。实际采样间隔为 1 ms 时，自动绘图在 50–100 ms 间调节；交互及维护请求可打断自动刷新计时器。健康的 100 Hz 绘图不按历史长度固定限帧。采样间隔读取记录尾部的逐点间隔，没有有效值时回退到当前设置，设备协议、CSV 和设置格式兼容性保持不变。

录制与回看各自维护密度策略；回看固定以一个画布像素为桶预算单位，慢帧不降低其精细度。回看密集曲线按通道复用同一份有界 RGBA 位图绘制原有 min/max 像素列，仅提交该通道覆盖的行；关闭填充时按原叠加顺序合并所有通道，一次上传。保留不均匀时间戳间的连线、缺失值断点和通道叠加顺序。面积填充拆成相邻条带的独立四边形，保留原有边界、基线和填充面积，避免一个大轮廓含有大量折返边；原始点仍走 uPlot 路径。

像素列位图和独立条带填充只作用于主图。导航缩略图保持 uPlot 描边，按自己的全历史点数和固定桶预算选择原始点或线性分桶路径；主图放大到原始点窗口不会改变导航投影。导航路径构建不读写主图的填充几何缓存，避免导入后描边被清空，以及导航重绘后主图填充消失。

压力反馈只统计实际 JS 绘制及绘制后的帧延迟，准备和导入的耗时不计作曲线压力。同一数据源的暂停、拖动和密集窗口切换保留已确认的填充保护，稀疏窗口、数据替换及显示设置变化使保护失效。填充尚未确认健康的连续交互会等待最多三个 rAF 的绘制反馈，期间合并最新窗口；已确认健康或关闭填充后恢复逐帧刷新，松手直接提交最终位置。上述策略不参与采集、保存、统计或积分，验证及限制见 [回看精细度修复](PERFORMANCE.md#2026-10-04-回看精细度修复)。

## 数据流

1. 前端调 `enumerate_devices` 合并 WITRN HID 与 POWER-Z Bulk 设备列表。
2. 前端调 `connect_device_by_path` 连接选中的接口；POWER-Z 先完成 Bulk 握手。
3. 后端按设备家族启动采集源、IPC 发射线程；POWER-Z 的协议控制由独立 CDC 线程拥有串口。
4. 选择 1 ms 时，采集源执行 HardwareID 读取、StreamingAuth、StartGraph(3)，每 20 ms 请求 AdcQueue；认证失败自动切回 10 ms。
5. 合法数据经事件系统推送：测量帧走 `device-data-batch`，PD 报文走 `pd-data-batch`，前端更新读数卡、图表、统计与记录文件。

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

Node 内置测试运行器（`node --test`）覆盖核心逻辑和跨文件契约，需要浏览器 API 的部分使用 mock。主要文件按领域组织如下，实际数量以 `npm test` 输出为准：

```
bench-gate  chart-binding  chart-buckets  chart-columns  chart-cooperative
chart-cursor  chart-extrema  chart-feedback  chart-pacing  chart-window  csv-codec  csv-import
device-stream  frame-scheduler  ingest  km003c-model  measurement
pd-capture-file  pd-model  range-stats  recording  recording-spool
security-csp  settings-persistence  tauri-config  temp-disconnect  version-sync
```

这些测试保护数据处理、CSV、采集、录制、协议解析、性能门禁、安全 CSP、发布版本同步和已确认的高影响缺陷。普通 UI 布局、样式、文案、控件数量和功能表面变化不单独建立回归测试；规则详见 [开发与构建：测试与回归边界](DEVELOPMENT.md#测试与回归边界)。

### Rust workspace

四个 crate 的单元、集成和文档测试由 `cargo test --workspace` 运行；`cargo fmt --check --all`、workspace Clippy 以及协议 crate 的非默认 feature 组合由 CI 固定检查。真实 HID 设备和外部温度服务仍按需手动检查，不属于自动化回归链路。

| 位置 | 覆盖 |
| --- | --- |
| `crates/usbpd-parser` | 协议字段、渲染及完整会话回放 |
| `crates/witrn-hid` | 设备接口筛选与测量帧解析 |
| `crates/km003c` | 协议、Bulk、CDC 与触发状态机 |
| `src-tauri` | 采集、合批、队列时基、文件句柄与恢复文件 |

协议库的文档测试随 `cargo test --workspace` 一并运行；测试数量以该命令的实际输出为准。

硬件相关路径（真实 HID 设备、TCP 温度服务）未接入自动化测试。

CI 的 Rust 步骤都是工作区范围（`--all` / `--workspace`），四个包全部受 fmt / clippy / test 检查；另有一个 `crate-features` job 专门跑协议 crate 的非默认特性组合。详见 [开发与构建 · CI](DEVELOPMENT.md#ci-门禁)。

开发预览由 `tools/showcase/server.mjs` 在本地 HTTP 响应中注入虚拟 Tauri 桥接，设备数据仍通过前端现有事件流摄入。模拟代码、场景与 PD 样例均位于 `src/` 外；正常构建只从 `src/` 生成 `out/`，因此安装包不包含开发工具。详见 [开发展示工具](DEVELOPMENT.md#开发展示工具)。

## 安全边界

- **CSP** —— WebView 启用内容安全策略，`img-src` 只允许 `self`、`asset:` 与 `blob:`，`connect-src` 只允许 `self` 与 IPC。`script-src` / `style-src` 均为 `'self'`，不含 `'unsafe-inline'`（Tauri 编译期会给本地脚本补 hash、给样式补 nonce）。
- **对话框能力最小化** —— `capabilities/default.json` 只授予 `dialog:allow-open` 与 `dialog:allow-save`。应用内确认框走 `<dialog>`，不授权原生 message/ask。
- **文件系统能力最小化** —— 插件权限保留 `fs:default` 与 `fs:allow-write-text-file`，不授予主目录递归写权限。CSV / PD 文件通过 Rust 文件句柄接口分块读写；路径由原生对话框或受控缓存目录决定，前端不能提交任意路径打开文件，单块最多 4 MiB。
- **窗口能力** —— 因为使用无边框自定义标题栏，需要一组 `core:window:allow-*` 权限（拖动、缩放、最大化等）。
- **无网络依赖** —— 前端运行依赖全部 vendor 到 `src/vendor/`，运行时不从 CDN 加载脚本或样式。唯一的网络行为是用户主动配置的外部温度服务（出站 TCP）。
