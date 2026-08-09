[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

# WITRN-RS

WITRN-RS 是一个跨平台的桌面应用程序，用于连接和监控维简 (WITRN) USB 电压电流表。该项目基于 **Tauri v2** 构建，后端使用 **Rust**，前端使用原生 **JavaScript/HTML/CSS**。

**注意：本软件大部分使用Copilot等VibeCoding工具制作，可能存在未知问题**

## 致谢
感谢 WITRN 提供的 USB-PD 采集硬件支持

感谢所有开源项目贡献者

感谢[JohnScotttt](https://github.com/JohnScotttt)的HID实现

## ✨ 功能特性

### 核心功能
*   **实时监控**：实时读取并显示电压、电流、功率和温度；容量 (mAh) 与能量 (Wh) 由软件按录制区间积分
*   **图表显示**：支持实时数据图表显示和历史数据导航
*   **数据导出**：支持 CSV 格式数据导出（可选择是否包含温度数据）
*   **统计信息**：显示最小值、最大值、平均值等统计数据
*   **多设备支持**：支持多种 WITRN 设备型号的自动识别和连接

### 高级功能
*   **密集网格显示**：主图支持细分网格线绘制，提升读取趋势和局部变化时的参考精度
*   **平滑退出机制**：优化窗口关闭与应用退出流程，降低后台线程/设备读写竞争导致的关闭卡住问题
*   **填充控制简化**：曲线填充改为由透明度直接控制（0 = 关闭填充，1-100 = 开启填充）
*   **外部温度服务**：支持通过网络连接外部温度传感器数据
*   **跨平台**：支持 Windows、macOS 和 Linux 系统
*   **轻量级**：基于 Tauri 构建，安装包体积小，运行资源占用低
*   **自定义采样率**：可调节数据采样频率以适应不同使用场景

## 📱 支持的设备

目前支持以下 WITRN 设备：

*   **WITRN K2** (VID: 0x0716, PID: 0x5060)
*   **WITRN U3** (VID: 0x0716, PID: 0x5063)
*   **WITRN C5** (VID: 0x0716, PID: 0x5053 / 0x5064)

## 🛠️ 开发指南

### 环境要求

*   [Rust](https://www.rust-lang.org/tools/install) (推荐最新稳定版)
*   Tauri CLI v2（建议：`cargo install tauri-cli --version ^2`）
*   操作系统支持的 HID API

Node.js 20+ 仅在运行 JavaScript 测试、类型检查或格式检查时需要，不参与应用运行或 Tauri 构建。

前端质量工具版本由 `package-lock.json` 锁定：Biome 2.4.4 负责 JavaScript、JSON、CSS 和 HTML 的 lint、格式检查及导入整理；TypeScript 负责带 `// @ts-check` 的 JavaScript 类型检查。`npm run lint` 会将警告视为失败，`npm run format` 可应用 Biome 的安全格式化。`.editorconfig`、Biome 和 `.gitattributes` 共同约束文本文件使用 LF。

### 快速开始

1. **克隆仓库**：
   ```bash
   git clone https://github.com/KHWLGH/WITRN-RS.git
   cd WITRN-RS
   ```

2. **安装构建工具**：
   ```bash
   cargo install tauri-cli --version ^2
   ```

3. **运行开发环境**：
   ```bash
   cargo tauri dev
   ```

4. **构建生产版本**：
   ```bash
   cargo tauri build
   ```

5. **运行与 CI 相同的质量检查（可选）**：
   ```bash
   npm ci
   npm test
   npm run typecheck
   npm run lint
   cargo fmt --check --manifest-path src-tauri/Cargo.toml
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo check --manifest-path src-tauri/Cargo.toml
   ```

仓库中的 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 会在 push 和 Pull Request 时执行上述检查。`npm ci` 使用已提交的 `package-lock.json` 安装固定版本的前端质量工具。

### 构建说明

- 首次运行可能需要较长时间下载依赖
- Windows 用户可能需要安装 Microsoft C++ Build Tools
- Linux 用户可能需要安装相关的 WebView 和 HID 库

## 🌡️ 温度服务功能

### 概述
应用支持通过网络连接外部温度传感器，实现温度数据的实时监控和记录。

### 使用方法

1. **启动温度服务器**：
   ```bash
   python temperature-example/network_server.py
   ```

2. **在应用中连接**：
   - 设置 IP 地址（默认：127.0.0.1）
   - 设置端口号（默认：1573）
   - 点击"连接"按钮

3. **数据格式**：
    - 服务器通过 TCP 发送纯数字温度值
    - 每行一个数值，以换行符结束
    - 发送间隔可以超过 10 秒，服务会在空闲期间保持连接
    - 示例：`25.125\n`

### 示例文件
- [`temperature-example/network_server.py`](temperature-example/network_server.py) - 温度服务器示例（发送随机温度数据）
- [`temperature-example/network_client.py`](temperature-example/network_client.py) - 温度客户端示例（测试用）

## 🏗️ 项目架构

### 后端 (Rust)
- **位置**：`src-tauri/src/`
- **核心文件**：
  - `lib.rs` - 主要应用逻辑、状态管理、Tauri 命令
  - `main.rs` - 应用入口点
- **功能模块**：
  - HID 设备通信 (使用 `hidapi` 库)
  - 温度服务网络连接
  - 后台任务生命周期管理（每个 HID/温度连接持有独立停止标志与 `JoinHandle`，重连和退出前等待旧任务结束）
  - 线程安全的共享配置与设备信息管理 (`Arc<Mutex<...>>`)
  - 事件系统（向前端发送实时数据）

### 前端 (Vanilla JavaScript)
- **位置**：`src/`
- **模块结构**（ES Modules，启用 `// @ts-check` 类型检查）：
  - `app.js` - 应用入口、Tauri API 导入、窗口关闭、UI 事件绑定
  - `state.js` - 共享应用状态与类型定义
  - `chart.js` - uPlot 图表初始化、渲染调度、tooltip/图例交互
  - `data.js` - 数据采集、统计计算、录制逻辑
  - `measurement.js` - 相对时间解析、能量/容量积分、导出行构造（不依赖 DOM 与 Tauri 的纯函数，供单元测试直接调用）
  - `device.js` - HID 设备连接管理
  - `csv.js` - CSV 导入/导出
  - `settings.js` - 设置加载/保存（防抖持久化）
  - `temperature.js` - 温度服务网络连接
  - `utils.js` - 通用工具函数
  - `global.d.ts` - Tauri 全局 API 类型声明
- **其他文件**：
  - `index.html` - 应用界面结构
  - `styles.css` - 界面样式
- **前端运行时依赖**（均已 vendor 到 `src/vendor/`，本地运行无网络依赖）：
  - uPlot - 图表绘制（轻量高性能，替代原 Chart.js）
  - Tauri Plugin Store - 设置持久化
- **开发质量工具**：Biome 2.4.4、TypeScript 5.x（仅由 `npm ci` 安装，用于质量检查）

### 测试 (`test/`)

前端测试使用 Node 内置测试运行器（`node --test`），只覆盖不依赖 DOM 与 Tauri 的纯逻辑：

- `measurement.test.js` - 相对时间解析（含 `D.hh:mm:ss.ms` 天数前缀）、相邻区间能量积分、导出行构造
- `recording.test.js` - 录制会话边界重置积分基线、导入后续录从最后一个相对时间点继续

Rust 侧测试以 `#[cfg(test)]` 内联在 `src-tauri/src/lib.rs`，覆盖 HID 帧解析校验与多接口筛选。硬件相关路径（真实 HID 设备、TCP 温度服务）未接入自动化测试。

### 数据流
1. 前端扫描已知 VID/PID 的设备；同一物理设备有多个 HID 接口时，后端优先选择厂商自定义 Usage Page
2. 前端调用 `connect_device_by_path` 连接选中的接口
3. 后端启动该连接独享的数据读取任务，解析并校验 HID 报告
4. 合法数据通过事件系统推送到前端 (`device-data` 事件)
5. 前端更新 UI、uPlot 图表、统计及录制区间内的 Wh/mAh 积分

### HID 协议规范
- **报告大小**：64 字节
- **协议头**：第 0 字节必须为 `0xFF`
- **数据字段**（小端序）：
   - 电压：字节 46-49 (`f32`)
   - 电流：字节 50-53 (`f32`)
   - 温度：字节 42-45 (`f32`)
   - D+/D- 电压：字节 30-33 / 34-37 (`f32`)

解析器会拒绝长度或帧头错误、非有限数值以及明显超出物理范围的报告。目前未实现协议校验和验证；新增设备型号或固件前应先用实机样本确认字节布局与量程。

### 安全边界

- Tauri WebView 启用了基础内容安全策略 (CSP)
- 文件系统能力只保留 CSV 导出所需的文本文件写入，不授予主目录递归写权限
- 前端运行依赖均保存在 `src/vendor/`，应用运行时不从 CDN 加载脚本或样式


## 🚀 使用说明

### 基本操作
1. **连接设备**：
   - 插入 WITRN 设备到 USB 端口
   - 点击设备选择下拉框旁的刷新按钮扫描设备
   - 选择目标设备后点击"连接"

2. **数据监控**：
   - 连接成功后可以开始实时数据采集
   - 查看实时数值卡片显示的当前数据
   - 观察图表中的历史数据趋势

3. **设置调整**：
   - 调节采样率以控制数据更新频率
   - 选择要显示的数据类型（电压、电流、功率等）
   - 配置温度服务连接参数

### 数据导出
- 支持 CSV 格式导出历史数据
- 可选择导出完整数据或排除温度数据
- 导出文件包含时间戳和所有采集的参数

## 📋 常见问题

### 设备连接问题
- **设备未被识别**：确保设备驱动正确安装，尝试重新插拔
- **连接失败**：检查设备是否被其他程序占用，重启应用程序
- **数据显示异常**：确认设备型号是否在支持列表中

### 温度服务问题
- **连接超时**：检查 IP 地址和端口号是否正确
- **数据格式错误**：确保温度服务器发送的是纯数字格式

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 GNU 通用公共许可证 第3版 (GPLv3)。详情见仓库根目录的 [`LICENSE`](LICENSE) 文件。

## 📝 更新日志

查看完整的版本历史和更新记录，请访问 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 🔗 相关链接

- [Tauri 官方文档](https://tauri.app/)
- [维简官方网站](https://www.witrn.com/)
- [Rust 官方网站](https://www.rust-lang.org/)

**如有问题或建议，欢迎提交 Issue：https://github.com/KHWLGH/WITRN-RS/issues**
