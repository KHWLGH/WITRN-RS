# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **POWER-Z KM003C / KM002C 支持**：设备列表新增第二个枚举源 —— POWER-Z 按 VID `0x5FC9` 单独枚举（KM003C `0x0063` / KM002C `0x0061`），Interface 0 走 Vendor Bulk（Windows 通常自动绑定 WinUSB，无需另装驱动）；新增工作区协议 crate `crates/km003c`（Bulk 传输、AES-128 认证、AdcQueue 与 CDC 文本控制），`publish = false`、LGPL-3.0-or-later，与另两个协议 crate 同规。POWER-Z 抓到的 PD 报文转成 64 字节 WITRN 报告帧后进入既有 PD 分析链路，解码树、筛选与导入导出都不必知道设备家族；温度由并行 ADC 快照补齐。后端读循环抽成两类设备共享的 `acquire.rs`（`Source::read` 只报告到达，节拍选点、PD 日志、未确认容量守卫与末包回执只有一份实现），通道容量 1024 → 4096 以承接 1 ms 采样。采样率下拉新增 `100 次/秒`（10 ms，两类设备都可选）与 `1000 次/秒`（1 ms，仅连接 POWER-Z 时显示；断开时若停在 1 ms 会退回 10 ms），后端 `set_sample_rate` 接受范围放宽到 1 – 60000 ms、按设备下限钳制。
- **POWER-Z AdcQueue 高速采样**：KM003C/KM002C 现在支持 HardwareID 认证、1000 次/秒队列采样、设备时基展开、序号空洞统计，以及认证失败后自动回退到 100 次/秒；新增 `probe_queue` 实机探针。
- **POWER-Z 协议控制工作区**：连接 POWER-Z 后标题栏出现 `协议控制` Tab（Tab 条新增按设备隐藏的能力；维简设备不显示该 Tab，也不会发出任何控制命令）：PDM 会话（PD 类型 / 线缆模拟 E-Marker / Sink 能力，打开·关闭·应用）、电压触发（读取 PDO、自动检测、完整检测、复位；协议覆盖 PD / QC2.0 / QC3.0 / FCP / AFC / SFCP / SCP / VFCP / UFCS / BC1.2 / Apple，QC3 另有 ±200 mV 步进）、PDO 列表点击回填请求、返回日志，以及折叠的「高级协议命令」（pd cmd / pd data / Get_Source_Cap / 读取 UFCS PDO / 自定义原始命令）。命令一次一条、执行期间可取消，断开或 Bulk 重连自动结束 PDM 会话；表单规则、命令构造与日志格式是纯逻辑（`src/km003c-model.js`），可在 `node --test` 下直接测。PDM 开关状态以后端为准（`km003c-pdm-state`）、高速采样回退原因经 `km003c-high-rate` 提示，两者在视图未打开时也不会丢。
- **临时恢复文件与单次记录上限**：记录期间按秒把行追加进应用缓存里的临时 `.partial.csv`（每份单次记录一个文件，新建时写入定宽表头；已有的行在后台分块补写），追加按量触发（满 1 秒或满一批行）而不是定时器 —— 窗口最小化时 WebView 会节流定时器，而数据事件照常到达；暂停时写完剩余行、原地回写表头并同步，清空、导入或正常退出时关闭删除，写入失败自动暂停记录（数据仍在内存里，可手动导出）。启动时列出上次未正常结束的临时记录，可一键恢复（走导入路径）或删除；设置页「保留临时恢复文件」可关闭该机制。单次记录默认上限 512 MB（64 – 8192 可调，按约 100 B/点与 120 B/行估算、界面标「约」），达到即自动暂停，底栏「剩余」按当前采样率显示还能记多久。CSV 导出 / 导入改为**后端文件句柄**：路径只由原生对话框或应用缓存决定，前端拿到句柄与显示用路径，数据以原始字节分块传输（单块上限 4 MiB），不在 WebView 里拼整份文件字符串。
- **PD 元数据树的成本现在有人看着**：`cargo bench` 新增 `pd_metadata_tree_build`（实测 source_caps `5.79 µs`、good_crc `1.40 µs`，含解码 + 序列化成 IPC 字节）。它此前被刻意跳过，理由是"合成帧只能测到 CRC 拒绝路径，而且仓库里没有抓到的真帧" —— **这个前提是错的**：`pd_capture.rs` 自己的测试里就带着合法 CRC 的 Source_Capabilities 与 GoodCRC 报文，那条注释已按事实改写。bench 开跑前先断言 caps 那帧的序列化结果大于 GoodCRC 的两倍，前提不成立就 panic，而不是安静地把一条错误路径报成"树构建成本"。PD 是事件驱动不是 100 Hz，所以它**不进门禁**，只作斜率观测。
- **真机验收第一次被自动跑完，工具也进了仓库**：`scripts/hardware-acceptance.mjs`（`npm run accept:hardware`）经 WebView2 远程调试端口驱动**正在运行的那个应用** —— 调它自己的 `clearChart()`、录制开关和 CSV 编解码器，所以文件证明的是发货路径而不是一个长得像它的脚手架。一次 620 秒连续录制的回执：`coveredS 622.01`、`rows 62201`、`observedHz 100`、`maxGapMs 14.16`、`singlePointHoles 0`、`segments 1`、streamErrors/capacityErrors 均为 0、`passed: true`。它还顺带报 `emits/s` 与 `points/emit`（包住 `handleBatch`），和 debug 构建的 `bus-probe`（`offers/s` vs `selects/s`）合起来才能把"设备没发""节拍门丢了""合批没生效"三种故障分开。回执同时带上溯源字段 `provenance.headCommit` / `treeClean` /（给了 `--exe` 就有的）`exeSha256`，校验器对它们**默认拒绝**：工作树不干净、或溯源与 `--commit` 不是同一份代码，都不能当发版凭据。上面那两次跑出来的回执正是被这条新规则判红的 —— 数据链路完全干净，但 exe 里带着未提交的改动，所以"验收通过的代码"在仓库里不存在。驱动与校验器之间的交接面另由 `test/acceptance-tool.test.js`（2 条）钉住：坏参数（`--seconds abc`/`3`/`Infinity`、`--poll-ms 5`、死端口、读不到的 `--exe`）必须逐条拒绝并给出可懂报错，驱动打印的那条 `verify:hardware` 里每个 flag 都要真的被校验器认账 —— 把一个 flag 改名就会红，这条验过。
- **性能测量台现在能判定回退**：`bench/` 此前全部是 report-only —— `--baseline` 只改输出路径，仓库里**根本没有比较代码**，CI 也从不跑任何 bench，因此一次 +54% 的算法回退可以静默合进来。现在 `node bench/core.mjs --compare` 会读入库的 `bench/baselines/core.json`（只含输入 sha256、fixture 版本、受门指标集合与 p50/p95 的**投影**；逐次样本与主机信息留在不入库的 `bench/results/`），并返回非零退出码。判定链三层，每层都是被实测逼出来的：① 扣除环境漂移 —— 取本轮可门禁指标里**最小**的比值当作机器状态（用中位数会被回退自己污染，见 Fixed）；② 指标自身 `p95/p50` > 1.5 时降级为只报告（15% 阈值落在它的噪声里，`flatten` 实测离散度 1.78）；③ 默认 3 轮互证，必须每轮都超阈（奇数是因为首轮 JIT 离群值会占掉两均值的一半）。`--verify-baseline` 只查结构不查数值，因此可以安全进 CI：手改输入指纹会红，正常抖动不会。
- **门禁规则本身有测试**：`test/bench-gate.test.js` 锁住上面三层加 `projectBaseline` 的两条拒绝路径。它是突变验证过的：把估计量从最小值改回中位数，"回退覆盖多数指标"那条会红。
- **文档里的可执行说明现在会自己验货**：新增 `test/docs-commands.test.js`（6 条）。这一整个性能工程写了几十条 `node bench/x.mjs --flag`、`npm run y` 和文件路径，全部是手抄进文档的 —— 而手抄一定会腐烂：本会话里 `docs/DEVELOPMENT.md` 就出现过"npm test 是 17 个文件 / 110 个用例"与 `docs/ARCHITECTURE.md` 的"18 个文件"互相矛盾、以及 dev 循环描述在 `frontendDist` 改指 `out/` 之后整段失效。测试不比对文字，只比对**结构**：文档提到的每个 `node bench|scripts/*.mjs` 必须存在、每个 flag 必须出现在该脚本 `options()` 的默认键里（kebab→camel 规则与 `common.mjs` 一致，且解析器只解出 <3 个键时判为"解析器不可信"，防止静默空跑）、每个 `npm run x` 必须是真脚本（跳过"不是 npm run tauri dev"这类刻意的反例）、每个**可运行**的 bench 入口必须被文档提到（用 `pathToFileURL(process.argv[1]` 守卫识别入口，`common.mjs` / `fixtures.mjs` 这类库不算）、文档正文反引号里的路径式字符串必须存在。两条突变各自只红一条：文档写 `--nope-flag` → 报"core.mjs 没有 --nope-flag（可选键：…）"；把 `bench/packaging.mjs` 改名 → 报"文档写了不存在的脚本"。用例总数从 189 涨到 194。**同一条契约现在也管 CI**：`.github/workflows/*.yml` 里写的每个 `node bench|scripts/*.mjs` 与 `npm run x` 都过同一套校验 —— workflow 里的命令同样是手抄的，而它比文档更危险：文档写错人会在本地撞上，CI 写错要么在 PR 上才红，要么那一步本来就是 report-only 于是静默地什么都不检查。突变验证：把 `ci.yml` 的 `--verify-baseline` 改名 → 报 `ci.yml: bench/core.mjs 没有 --nope-baseline（可选键：…）`，还原即绿。用例总数现为 214。
- **发版前置闸门补上了（计划 WP8 里那个 `release-perf.yml`）**：核心设计是**验收凭据必须从导出的 CSV 反推，而不是靠人填汇总数字** —— "100 Hz 满 600 秒无丢点"这个命题完全蕴含在 CSV 里（60,000 行、`RelativeTime(s)` 步进 ~0.01s、无空洞、无重复、无倒退）。新增 `scripts/verify-hardware-receipt.mjs`（两种模式：`--csv` 出回执并判红绿，`--receipt` 只能查自相矛盾并明说这一点）与 `scripts/check-release-tag.mjs`（tag 处三处清单版本必须一致 + 回执的 commit 必须是该 tag 的祖先），以及 `.github/workflows/release-perf.yml`（`workflow_dispatch`：不创建 tag、不发 Release、不构建安装包，只做校验并打印人工后续步骤；粘贴的回执经环境变量落地，绝不拼进命令行）。校验器**故意不复用** `src/csv-codec.js` 的 `parseCsv`：导入器为了"用户重载旧文件不炸"会静默跳过畸形行，照抄这种宽容会把 59,000/60,000 判成干净 —— 这是本仓库少见的"两个正确程序不能共享同一个解析器"的情形，写进了两处注释。`test/hardware-receipt.test.js` 用应用自己的编码器造 CSV，钉住六种拒绝（空洞 / 倒退 / 重复 / 速率偏离 / 时长不足 / 损坏行）加缺列表头；它还**当场抓出一个会把正确输入判红的规则 bug**：`durationS` 是首尾样本之差，比实际覆盖少一个采样周期，因此"要求 ≥600s"会让一份完美的 60,000 行/100 Hz 文件以 599.99s 失败 —— 改成判 `coveredS`。所有分支都在本仓库现成的 tag 上实测过：`--tag v0.2.1` 绿、不存在的 tag 红、v0.1.5 暴露出根 `Cargo.toml` 当时还不存在（今日发版该红，保留）、回执 commit 换成 tag 之后的 commit 红。npm 侧新增 `verify:hardware` 与 `check:release-tag` 两个脚本，文档在 `docs/DEVELOPMENT.md` 的"发版前置：真机验收凭据"。**随后修掉一条会把正确运行判红的规则**：验收期间按过手动暂停的话，`addDataPoint` 在暂停段直接 return，文件里留下合法的时间空洞，而 `deviceStream.seq` 继续前进 —— 原来的单条"间隔超限 = 丢点"会把这次运行判成损坏。现在跨录制分段的空洞单独计成 `pauseHoles`、不算丢点，同时"检测到 >1 个分段"本身就是一条独立拒绝（验收的命题是"一次连续的 100 Hz"，暂停过的运行不是这个命题，重跑比放行诚实）；反向保障也写了测试：同样的空洞落在同一段内仍然是丢点，分段不是免罪符。空单元格解析也修了 —— JS 里 `Number('') === 0`，会把"该行没有分段"读成一个真实存在的段号 0，必须显式转成 `NaN`。**又消掉一处"取决于操作者手打"的输入**：导出头里的 `SampTime(ms)`（= 应用的 `settings.sampleRate`，单位毫秒，`10` 就是 100 Hz）现在会与 `--hz` 核对，不一致直接拒 —— 在此之前"这是不是一次 100 Hz 验收"只看命令行里填了什么。实测：真 100 Hz 文件 rc=0，把 10 Hz 的文件用 `--hz 100` 送去 rc=1 并点名两者不符。头的 `SUM` 只报不判，理由与导入器不信它一致（Excel 重存、截断文件都存在）。这条规则顺带暴露我自己的夹具单位错了（测试里把 `sampleRate` 当 Hz 传，实际是 ms 间隔），改对后 13 条全过；用例 207 → 208
- **同一套闸门里随即拆掉了一个"自己声明自己通过"的洞**：第一版 `verify-hardware-receipt.mjs` 的回执里 `declared: {streamErrors: 0, ...}` 是**工具自己写死的 0** —— 也就是说那两个字段无论真实情况如何都会通过，是标准的空转检查。现在它们必须来自应用本身：`src/device-stream.js` 新增 `diagnostics()`（`seq` / `streamErrors` / `capacityErrors` / `generation` / `failed` / `lastError`），`src/device.js` 在初始化时把它挂成 `window.__WITRN_STREAM__`（只读，不在消费路径上加任何东西），校验器改为**必填** `--diagnostics`，缺就拒绝出回执。这一改动顺带补上了一个 CSV 原理上看不见的洞：`producedSeq ≠ rows` 才有办法发现"设备→Rust→JS→CSV 中间丢了 N 点"，而只看 CSV 时那种丢失表现为一份完全规矩的文件。内部 `fail()`（seq 空洞、时间戳非法）与 IPC 侧 `handleError()` 现在写同一张错误表，之前只有后者会被记到，等于"自己发现的丢点不算错误"。测试：`test/device-stream.test.js` 钉住计数与"陈旧 generation 也计入"（中途重连就该重测），`test/hardware-receipt.test.js` 钉住 `rows ≠ producedSeq` 与缺声明两条路径；CLI 四条分支实测（干净 rc=0、丢 500 点 rc=1、缺 `--diagnostics` rc=1、mode 2 复查 rc=0）。用例 203 → 206
- **`bench:ui` 第一次证明 `producedSeq` 的前提是真的**：回放结束后把 `deviceStream.diagnostics().seq` 与流水线报告的 `lastSeq` 比对（实测 300 === 300，`src` 与 `--dist out` 两种模式都过）。在此之前"应用产出点数 == CSV 行数"只是我相信的一个假设。读数走单例，同时断言 `window.__WITRN_STREAM__()` 可调用且与单例读数 `deepEqual`；存在性另在更早、不依赖帧的阶段断言。（上一条里那个"未解释的观察"已经解释清楚，原因在我：那次表达式写成 `window.__WITRN_STREAM`，**少一个尾下划线**，拿到 `undefined`，我却记成"应用在 sustained 之后把全局弄没了"。可疑之处在于存在性断言通过而数值断言失败 —— 两条读的不是同一个名字。教训不是"小心拼写"，而是一条具体规则：**文档让人在 DevTools 里输入的入口，必须有断言真的走它**，否则人照文档做验收时才发现路是断的。突变验证：把检查里的名字改错一个下划线 → rc=1 并打印"文档里让人输入的那个入口是坏的"）
- **`bench:ui` 的三个健壮性缺陷**（都是被"今天突然跑不动"逼出来的）：① 标定环节 `await new Promise(requestAnimationFrame)` 在窗口被完全遮挡时永不 resolve，我上一轮加的"截止时间优先"因此来不及生效，症状是 60 秒后一句无信息的 `CDP timeout` —— 改成 rAF 与 250ms 定时器赛跑，拿不到帧就不计数，10 秒凑不满 20 帧就抛"这是前置条件不是精度问题"；② 导航后 `Page.bringToFront`，让自有的窗口真的被合成；③ 七个 `Runtime.evaluate` 跑完之前一个数字都不打印，出错只剩方法名 —— 现在每个阶段向 stderr 发 `{stage, atMs}`（与那两处 CI `2>/dev/null` 是同一类错误：仪器不肯说自己死在哪一步）
- **`tauri.windows.conf.json` 第一次有东西守着**：新增 `test/tauri-config.test.js`。平台覆盖层只在对应系统被读取，所以 macOS / Linux 的 CI **永远不会打开这个文件** —— 而 WebView2 的 `--enable-gpu-rasterization --enable-features=CanvasOopRasterization` 恰恰只写在里面，CHANGELOG 已宣称发货却没有任何东西验证它存在。更要紧的是合并语义：平台层的 `app.windows` 是**整个数组替换**而非逐字段深合并，所以覆盖层少写一个键 = 在 Windows 上把基础配置那个键悄悄删掉。测试钉住四条：覆盖层不得丢键、共有键取值必须与基础一致（只准加键）、GPU 栅格化参数还在、`visible` 仍是默认可见（把"先测不改"的约定变成要改必须先动测试的关卡），外加 `frontendDist: ../out` 与两条 build 命令的配套关系。三条突变各自只让一条用例红
- **打包形状测量 `bench/packaging.mjs`**：报每文件字节、首帧阻塞取回次数、无引用资产、（若已构建）release 镜像大小。它是 `bench/` 里唯一确定性、零噪声、因此不需要基线也不需要互证的测量台。主要价值是把"删掉某个没人引用的文件"从一次性清理变成通用规则：**新出现的无引用文件会让门禁失败**。它区分三类不同的缺陷，且**问的是真正的 `frontendDist`（现在指向 `out/`）而不是 `src/`** —— 自 CSS 合并那步起两者就不是一批文件了，只看 `src/` 会既报错又不报该报的：① 已跟踪但无人引用 = 白占所有用户体积；② 在 `out/` 里但没被 git 跟踪 = `tauri-codegen` 照样内嵌，**这个二进制无法由干净检出复现**（本地实测点出 7 个这样的前端文件，正是提交边界要的门禁）；③ 根本不该发货的条目（`*.d.ts`、点号目录）= 纯字节浪费。③ 曾是真实缺陷：`src/.playwright-cli/page-….yml` 与 `src/global.d.ts` 都会被 `build-dist.mjs` 的镜像步骤复制进 `out/` 再内嵌，而 `.gitignore` **拦不住内嵌**（codegen 按文件系统走，不看 git）—— 现在 mirror 显式排除它们，并由 `neverShippable` 断言钉住。另有一个**门禁自己说谎**的缺陷被"干净检出模拟"抓出来：`frontendDist` 不存在时，`packaging.mjs` 以前打印"跳过内嵌集合检查"然后 **exit 0** —— 也就是两条最有价值的断言（未提交却被内嵌、本不该发货）在最需要它们的场合（还没跑过构建的检出）完全不可达。现在改成断言失败（实测无 `out/` 时 rc=1，跑过 `npm run build` 后 rc=0）
- **干净检出模拟证明 WP0 的文件清单是完整的**：把 `git ls-files` 与"应当新增跟踪"的文件集（238 个）复制到临时目录、`git init` + 提交、软链主仓库的 `node_modules`，然后在那棵只含提交内容的树里跑全套：`npm test` **194 条，与主工作区完全一致**（少一个测试文件这里就会静默少跑，这是清单完整性的直接证据）、`npm run lint` 88 文件 0 错、`npm run build` 产出 `out/` 后 `bench/packaging.mjs` 三条内嵌断言全过（"未跟踪却被内嵌：无"、"本不该进包：无"、68 个内嵌文件全部已跟踪）、`bench/core.mjs --verify-baseline` 报结构一致。也就是说：按这份清单提交之后，CI 与任何人的干净检出都能复现出发货的那个二进制。这个模拟同时是发现上一条 vacuous-pass 的手段
- **Rust 侧热路径基准 `cargo bench -p witrn-rs`**：此前 Rust 一个基准都没有（18 个 `.rs` 里的 `#[test]` 全是正确性测试），最接近的只是一条打印吞吐的 `#[ignore]` 测试。`src-tauri/benches/stream.rs` 用 criterion 补上三组：`decode/general_sample` **6.5–7.0ns**（无分配地板，它变慢就说明每帧路径上被加了东西；区间是同一份代码跨轮实测的漂移，见下一条）、`emit_json_batch/to_vec_n{1,8,32,64}`（**~240 字节/点、~221ns/点**，n=64 时 4.54 Melem/s）、`selection/offer_select_retain` 与 `emit_loop_channel_only`。为了让 bench 能驱动 emit 路径，`mod stream` 提为 `pub mod stream`，同时把 `Sample::data` 收为 `pub(crate)` —— bench 因此只能传递和序列化 `Sample`，不必把 `DeviceData` 也公开出去。PD 解码刻意**不做**基准：`decode_pd_report` 要校验 CRC，合成帧量到的是错误路径而不是 `Metadata` 的分配成本，而仓库里没有真实抓包可当夹具
- **但 criterion 自带的 change% 不能当门禁 —— 原计划这条被实测否掉**：计划里写的是"门禁走 criterion 自己的 change% 置信区间"。同一份**未改动**的 Rust 代码连跑三次 CI 档位（`--warm-up-time 1 --measurement-time 3 --sample-size 30`）：`decode/general_sample` 先 +11.7% "Performance has regressed"（p=0.00）再 −2.5% "improved"（p=0.00）；`selection/offer_select_retain` 一次 +8.4%、一次 **+19.9%**（都带 p<0.05）；`selection/emit_loop_channel_only` 同一对基准里先 −5.7% "improved" 后 +11.3% "regressed"。同一个指标跨轮翻符号、幅度到 20%，而 criterion 仍然报"p<0.05 显著" —— 它的显著性检验只覆盖轮内采样，不覆盖主机状态。所以 `perf-shape` 里 `cargo bench` 与 `core.mjs --compare` 都是 report-only，真正进门禁的只有确定性的那部分（结构校验、`--verify-baseline`、`bench/packaging.mjs`）。同一批测量也修正了引用方式：`decode/general_sample` 应当报成 **6.5–7.0ns 的一个带**（首轮 6.5ns、后续 6.91–7.08ns），它的用途是"地板被抬高就说明每帧路径上被加了东西"的趋势检测器，不是一个可引用的点数
- **据此取消"二进制传输替换 JSON"这条计划**：上面那 221ns/点意味着 100Hz（本应用上限）下 JSON 编码只花 **~22µs/秒 ≈ 单核 0.002%**，而剩余的 IPC 成本是每次 emit 的消息循环往返 —— 那正是上一条已经降到 1/4 的东西，不是每字节序列化。另外实测单点 JSON 就有 238 字节，一个 152 字节头的列式帧在小批下连载荷都不一定更小。原计划就写明这一包"若批形修好后数字证明不必要就直接砍掉"，现在数字到了
- **冷启动第一次有了分段数字**：新增 `boot_timing` 模块与 `bench/startup.mjs`。t0 锚在 `main()` 的第一条语句（`OnceLock` 同时存单调时钟与 epoch），再用 `performance.timeOrigin` 桥接两个时钟域 —— 于是"页面看不到的那一段"第一次可测。刻意**不**用"从进程启动算墙钟"当锚：安装器与 Defender 首扫会主导它。5 次冷启动 p50/p95（毫秒，相对进程启动）：`process_start` / `run_enter` / `plugins_registered` = 0 / 0 / 0（**本项目自己的 Rust 初始化 <1ms**）→ `context` 456/482（全在 `tauri::Builder::run()` 内：WebView2 环境 + 建窗 + 导航）→ `setup_enter` 484/513 → `platformProbed` 631/666（app.js 的 68 条 import 边 + uPlot 解析 + 一次 IPC）→ `firstPaint` = `firstContentfulPaint` 719/758 → `appReady` 772/822。两层结论：① 那 456ms 里**没有一毫秒是本项目写的代码**，所以任何"改我们自己的代码压启动"的预期只能落在这之后的 ~263ms 页面段上；② 窗口在 ~456ms 就被创建并显示而首绘要到 719ms，中间约 **263ms 是一个 `transparent: true` 且尚无 Mica 的空窗** —— "要不要 `visible:false`"第一次有了可讨论的数字。按约定本包只埋点，未改任何启动配置
- **冷启动的绝对毫秒被证明只在同批内可比，并据此撤掉了三处引用**：`bench/startup.mjs` 现在每轮启动后测一次固定工作量（32MiB sha256）作为 `hostProbeMs`。同一份 debug 二进制、同一天、四批测量的 `context`：482（probe 9.9ms）/ 723（17.3）/ 720（81.7）/ 1414（未加探测的最早一批）。两个结论都是不情愿的：① 绝对毫秒不能跨批引用，因此文档里"合并 CSS 让 firstPaint 723→645ms、每次取回 ≈2ms"这条推导降级为"当时那一拍的读数"，`--bundle-js` 的定价回到**未定**（要重新定价得先给工具加同批 A/B 两个二进制的能力）；② `hostProbe` 也**不能当除数** —— 探测从 17.3ms 走到 81.7ms（4.7 倍 CPU 吞吐差）时 `context` 反而一动不动（723 vs 720），说明冷启动不是 CPU 吞吐主导，除以探测值会造出不存在的精度，所以它只是"这批能不能信"的标记（漂移 >1.3 时直接打印警告）。取回次数自身也在 78–81 之间浮动
- **启动第一次能做配对 A/B**：`bench/startup.mjs --exe-b <另一个二进制>` 在同一批里交替启动两者（每对内部顺序翻转，排除各臂自己的首次而非全局 `slice(1)`），输出 `b/a p50` 与"b 快了几对"。这是上一条推翻绝对毫秒之后唯一还站得住的比较方式。A 臂用 `scripts/arm-unmerged-css.mjs` 造（**不能只手改 HTML**：`build-dist.mjs` 打包后会把九个源样式表从 `out/` 删掉，只改 `<link>` 得到的对照组指向的是根本没被内嵌的文件 —— 它照样启动、照样报出每个阶段、数字看起来完全合理，只是跑的是个没有样式的页面；第一次手工配对比照就是这么错的，量出"合并反而多 8 个请求"，方向整个反了，脚本现在会在链接数或文件数不符时直接抛错）。修好对照组之后的 12 次配对（主机空闲，两臂 `hostProbe` 都是 9ms）给出了三条各自有方向的结论：① **请求数是确定性的**：`resourceFrontend`（剔除 IPC 的前端请求）九表臂六次全 62、合并臂六次全 54，正好差 8（9 → 1），零方差；两臂 `resourceIpc` 恒等于 28（比值 1.000），这既证明按 host 分组是必要的也证明它是对的。② **启动收益是个位数毫秒**：`appReady` 730 → 725（0.994，3/5 对），`firstPaint` 671 → 667（0.996）—— 所以文档里"合并让启动快了 78ms"是错的，正确的说法是"少 8 次往返 + 约 0.6% 的时间"。③ 这一切以主机空闲为前提，同一份代码被加载时 `context` 会跑到 720–1414ms。顺带把 `--bundle-js` 的算法摆正：54 次里除去 1 样式表 + 4 `<script>` + 30 个 CSS `url()`，模块图约 19 次，按本批资源段 252ms / 62 次 ≈ 每次 4ms 折算，打包 JS 的上限约 **80ms 量级**，不是先前推测的 150ms —— 仍然是要先量再决定的事。支撑这套计数的两个仪器改动：`boot-timing.js` 的资源清单按 host 分组上报（`ResourceSummary.by_host`，一条 Rust 测试钉住键名不匹配时不会静默降级成空 map），并且额外在 `load` 时再报一次 —— `load` 之前清单是半张的，早期"87 → 79 次"那种读数其实混着"我们看得早晚"这个变量。
- **`firstPaint` 之前是"走运的那一次"，不是 p50**：页面第一次 `report_boot_timing` 发生在 `DOMContentLoaded` 后的第一个 rAF，那时 paint entry 常常还不存在，而 `boot-timing.json` 只有等后续 `mark` 到来才会被再写一次 —— 实测 5 次启动里只有 1 次带 paint。现在 `boot-timing.js` 另注册一个 `PerformanceObserver({type:'paint', buffered:true})`，paint 落地就再报一次；修复后 5/5 都有值（719–964ms）。工具侧同时把 `collect()` 的提前返回条件从"有 appReady"收紧为"有 appReady 且有 paint"，超时仍回退到最后一次读数
- 写入 `boot-timing.json` 门在 `debug_assertions` 之后：release 设了 `windows_subsystem = "windows"`，没有 stderr 可读，文件是唯一出口，而发货构建不碰磁盘。四条单元测试锁住两时钟桥接，以及 **`timeOrigin` 早于进程启动时报告 null 而不是编一个数**

- **前端产物改由 `out/` 发货，9 个阻塞样式表合成 1 个**：新增 `scripts/build-dist.mjs`（esbuild），`frontendDist` 从 `../src` 改指 `../out`，并接上 `beforeDevCommand` / `beforeBuildCommand`。JS **仍然逐字节不改**，被合并的只有 CSS。确定成立的部分：阻塞样式表 **9 → 1**（`out/index.html` 静态可查，`test/tauri-config.test.js` 与 `bench/packaging.mjs` 都盯着），bundle 里 30 个 `url()` 目标全部可解析、无重复产出，`--dist out` 启动检查报 505 条规则 / 0 个取不到。**时间收益的部分本条原先写的是"页面取回 87 → 79 次、firstPaint 723 → 645ms、appReady 772 → 698ms，约 6%、每次 ≈2ms，因此打包 JS 值 ~150ms"—— 这些读数全部撤回**：它们来自两批不同时间的启动（绝对毫秒跨批不可比，见上两条），而且"取回次数"当时还混着 Tauri 自己的 IPC 调用。用修好的配对 A/B 重测之后真实值是：**请求 62 → 54（正好少 8 次、六次零方差），`appReady` 730 → 725ms（0.994）**。所以 `--bundle-js` 是一个显式未实现、会直接报错的选项，而它值不值得做要按"每次 ≈4ms × 约 19 次模块图取回 ≈80ms 上限"重新估，不是当年的 150ms
- 该步骤把设计约束写成了断言：整棵 `src/` 先镜像进 `out/`、esbuild 只在 `out/` 内部运行。原因是 `src/` 与 `out/` 是兄弟目录，跨目录打包会让 esbuild 按共同祖先算相对路径，产出 `out/src/assets/…` 并把 28 个图标复制成 56 个 —— 首轮就踩到了，现在有 `有产物落在 out/ 之外` / `留下 N 个重复文件` 两条断言守着。另有 `no inline <script>` / `no <style>` / `no style=` / `data: URL 不得比源里增多` 四条：图标走 CSS `mask`，被 CSP 拦下时**控制台没有任何输出**，只会看到空白按钮，所以这类回归只能靠断言而不是靠看
- **cargo 从此依赖 Node**：`generate_context!` 在宏展开期嵌入 `frontendDist`，`out/` 不存在时 `cargo build` / `check` / `clippy` / `test` 全部失败。CI 里所有构建 `src-tauri` 的 job 都补了 `npm ci && npm run build`（包括原本只看 Rust、根本不需要 Node 的 `backend-other-platforms`，以及 Ubuntu 上的 Rust 那半边）；`crate-features` 不需要，因为它只 `-p usbpd-parser` / `-p witrn-hid`，从不构建 `src-tauri`
- **发货产物第一次真的被启动过**：`bench/ui-runner.mjs` 新增 `--dist <目录>`（与 `--revision` 互斥 —— 历史 A/B 只在未打包源码上可行），让页面从 `frontendDist` 而不是 `src/` 服务，并断言"1 个外链样式表 / 合并后规则数 > 100 / CSS 里每个 `url()` 都能取到 / 应用真的起来了"。此前没有任何东西加载过 `out/index.html`：`build-dist.mjs` 只断言被引用的文件**在磁盘上存在**，而 `bench:ui` 一直服务原始 `src/` —— 也就是说一次写错的 `url()` 重写（正是 CSS 合并那步唯一会产生的新故障类别）可以绿着 CI 进包，表现为一个空白图标：不发失败请求、不抛异常、控制台安静。实测 `out/` 现在：505 条规则、30 个 `url()` 目标、0 个取不到。已作为 `ui-integrity` 的独立步骤进 CI。顺带修掉这个模式暴露的一处真实脆弱性：标定环节原来固定等 120 个 rAF 帧，前台标签页里是 0.7 秒，被节流时超过 30 秒 —— 直接 `CDP timeout: Runtime.evaluate`；改成截止时间优先（10s 或 120 帧，显式 60s 超时），且样本 < 20 时 `timingTrust.throttled` 直接为真（宁可说"这轮不可信"，也不拿一个虚构的节奏基准去分类丢帧）
- **CI 新增两个 job，并且按"会不会说谎"分层**：`perf-shape` 只硬门禁确定性检查（`bench/packaging.mjs` 断言 + `core.mjs --verify-baseline` 结构校验），计时（`--compare`、`cargo bench`）先 `continue-on-error: true` 只报告 —— 因为本机实测未改代码就会漂到 1.50×，一个会莫名变红、于是被人忽略的门禁比没有门禁更糟；`ui-integrity`（windows-latest）门禁 `bench:ui` 的**硬断言**（11 列 SHA-256、`lastSeq === count`、能量积分、并发 CSV 导出回环、零运行时异常），同样不门它的计时

### Fixed
- **一条终态流错误就把整个会话永久锁死：断开、重连、退出全部失败，只能杀进程**：`fail()` 落定 `failed` 之后，`waitForSeq()` 第一行无条件 reject，于是 `drain()` 必然抛错、`shutdown()` 永远走不到 `invoke('shutdown')`；`disconnectDevice()` 与 `connectDevice()`（连接前先 drain）同一条链上一起失败；`confirmAndExit()` 只 `console.error` 并复位标志位，所以 ✕ 会反复弹确认、永远退不出去。后端也帮不上忙：`connect_device_on_path` 在 `consumed != end.last_seq` 时直接拒绝重连，**所以纯前端改法连重连都救不回来**。修法是加一条显式的终态逃生口 `abandon_device_stream` —— 只接受「生产端已停 + 线程已 join + 已有末包回执 + generation 相符」的会话并退休它的槽位，且**绝不写 `consumed`**，空洞依旧算未消费。`shutdown` 的校验谓词一字未改（既有那条 `deepStrictEqual(calls.at(-1).args, {generation:1,lastSeq:2})` 仍然原样通过），放宽只发生在 `drain()` 已判定为终态、或第二次尝试的路径上。顺带补上 `handleEnd` 的空洞分支：它原先在 `end.last_seq !== seq` 时提前 return，既不置 `ended` 也不回调 `onEnd`，于是底栏可以永远停在「已连接」盖着一条死流。代价说清楚：尾批样本仍会被丢弃（它们在 `fail()` 那一刻就已经没了），区别是现在会说出来。**新增覆盖**：`test/device-stream.test.js` 5 条（终态仍能退出、终态绝不 ACK、空洞也退休会话、卡住的 drain 第二次放行、新 generation 回到严格路径），`src-tauri/src/lib.rs` 1 条 Rust 单测。drain 期限改成可注入的 `drainTimeoutMs`，否则「卡住的 drain」那条用例要真等 20 秒。
- **5000 ms / 10000 ms 档下累计能量与容量恒为 `0.0000`，带载也一样**：`MAX_ENERGY_STEP_S = 2` 是**绝对秒数**，而 x 轴侧的 `nextRecordingX` 早就按 `max(间隔 × 8, 2 s)` 放行点数了 —— 两套口径在 `(2 s, 8×间隔]` 这个区间里互相矛盾：点被画进时间轴，却被积分器当成空洞拒收。`src/index.html` 的预设里就有 5 秒 / 10 秒两档，它们的每一步都是 5 s / 10 s，于是 `wh += 0` 加了一整轮。改为 `energyMaxStepS(间隔) = max(2 s, 8 × 间隔)`，倍数与 x 轴保持同一个来源。标称间隔的取值优先级是：原生流的 `rate_ms` → 导入 CSV 的 `SampTime(ms)` → `settings.sampleRate`，全都不知道时退回绝对 2 秒（因此 `bench/core.mjs` 的 `referenceEnergy` oracle 与 `recording.test.js` 的「实时 ≡ 范围 ≡ CSV 往返」恒等式都不必改口径）。`parseCsv` 现在解析它**自己早就写出去**的 `SampTime(ms)` 摘要行（无需改格式），旧文件从相对秒序列取正步长中位数并夹到 10 – 60000。间隔存在 `state.dataIntervalMs` 这个运行时字段里，刻意不进 `settings`，免得导入历史文件改写用户的采样率设置（那条是 0.2.1 明确承诺过的）。**`rangeStatsCache` 的命中条件同时加上阈值**，否则改完采样率会复用一份按旧阈值折叠好的结果。
- **导入精确 CSV 后，「仅统计选中范围」把 `NaN` 当成平均电压显示出来**：`foldRangePoint` 只给温度加了 `Number.isFinite` 守卫，电压 / 电流 / 功率是三行无条件 `sum += v; count += 1`，而 `setText` 只挡 `±Infinity` 不挡 `NaN`。导入保留非有限值是既定契约（`csv-codec.test.js` 明写着），所以一个空着的 Voltage 单元格就能让读数卡显示字面量 `NaN`，一个 `Inf` 单元格让 min/max 显示 `--` 而旁边明明有有限样本。现在 v/c/p 完全照温度的写法守卫，均值取不到时给 `--`，并在均值旁用 tooltip 说明排除了几个点（「(N点)」仍是区间原始行数，这点写进文档而不是改标签）。修在折叠与显示层，**不在导入层净化** —— 列缓冲同时喂着图表，去 NaN 会改变往返保真。**新增覆盖**：`test/recording.test.js` 6 条，其中「范围模式与全量模式必须报同一个均值」是把这两套实现重新焊在一起的防分叉闸，另一条专门打增量折叠的复用分支（只补全量扫描路径的守卫骗不过它）。
- **设置写盘失败只进 console，用户以为已经存好了**：先纠正一处误判 —— 原本以为是「损坏的 `settings.json` 污染了 LazyStore」，查了 `tauri-plugin-store` 2.4.4 才发现 `build_inner` 里写的是 `let _ = store_inner.load();`，反序列化错误**被丢弃**，所以坏文件的表现是静默回落默认值、并在下次 save 自愈，不是这条。真问题另有两个：其一，`getStore()` 在 `await init()` **成功之前**就把实例发出去，而 `LazyStore` 缓存首次 `Store.load` 的 promise —— 任何真的会 reject 的原因（`resolve_store_path` 失败、命令尚未就绪、启动期一次 IPC 抖动）会让本进程余下的每次读写都复用那个已拒绝的 promise，持久化静默坏死且无法自愈；其二，落盘是裸 `fs::write`（没有 temp+rename），被杀毒软件或同步盘锁住时 `saveSettings` / `resetSettings` 只 `console.error`，于是「重置所有配置」看起来成功了、重启却全部回滚。现在改为成功才发布实例、失败可重试，`saveSettings` / `resetSettings` 返回布尔，并**每个故障期只提示一次**（防抖保存几乎每个控件变化都触发，不加节流这条修复本身就成了新 bug）。不做「用内存值覆盖坏文件」的自愈 —— 那要为此放宽 `fs` 权限，而 0.2.1 刚收紧过。另外保留显式 `await store.save()`：`autoSave` 的插件侧失败只在 Rust 记日志，`set()` 的 resolve 不代表已经落盘。**新增覆盖**：`test/settings-persistence.test.js` 4 条，含一条「干净读写必须零错误提示」防止修复退化成万能报错闸。
- **温度来源选「本机」时拔出仪表：读数冻结在最后一个值、按钮仍亮着「温度已连接」、`来源` 单选被永久锁住**：`setTempConnected` 只有两个调用方 —— `temperature.js` 自己，和前端对 `temp-disconnected` 的监听；而后端**只为 TCP 读取任务**发这个事件，本机源根本没有可关闭的会话。`setConnected(false)` 复位了记录 / PD / 状态栏，就是没碰温度。现在由 `temperature.js` 提供 `resetTempForDevice()` 并在断开时调用，带来源守卫：`source === 'device' && isTempConnected` 才成立（连接期间 `来源` 单选是禁用的，所以这个组合足以证明温度来自那只已经消失的仪表），外部的 TCP 会话不会被 HID 断开牵连。**有意不清 `state.hasTempData`** —— 那会把用户已经记录下来的温度曲线一起藏掉，与 `clearChart()` 的规则保持一致；错的只是那个过期的实时读数。
- **验收门在低速率上会假红：7 处"丢点"其实一个都没丢**：把真机覆盖从 100 Hz 扩到 4 Hz（`SampTime=250`）之后，同一条 `singlePointHoles`（≥1.9× 标称周期的 `RelativeTime(s)` 空洞 = 少写采样点）判出 7 处丢点，而应用侧计数说 `488 产出 / 486 行`（差 2，正是停止录制的异步尾）、`missingRows 0`、`observedHz 4.004` —— 数据一件没少。成因是选点网格在主机停顿后重新锚定、合并掉一个网格槽：低频下这是**合法**的节拍变化。现在空洞只报告、不判决，丢点的唯一判据换成"产出与行数的差超出一整批（64 点）"，比例级缺失仍由 `rows + missingRows = expectedRows` 的算术抓住；这条换法的代价也写进文档：≤64 行的内部抽行无法与合法停顿区分，门不再声称能抓它。顺带确认了新节拍门的另一条分支在真机上成立：**5 个 20 秒窗口全部交付 4.000 Hz**，抽稀比例没有被抖动侵蚀。
- **验收门把一次干净的 622 秒长跑判成"链路中间丢了 30 点"**：规则是 `producedSeq !== rows` 即红，理由是"只有应用侧的计数能证明链路中间没丢"。但它漏了一件事：停止录制是异步的，收尾那几批照样推进 `seq` 却不再落盘，于是这个差值**天然存在**且不代表丢点。真机第一次跑完就撞上了它（62,231 vs 62,201）。修法不是放宽阈值，而是换一个能真正定罪的判据：少写一个点必然在 `RelativeTime(s)` 上留下 ≥1.9× 标称周期的空洞（新 `singlePointHoles`），所以 `producedSeq > rows` 只在**同时**有空洞时才算丢点，否则原样记成 `boundaryResiduePoints` 放行。原来的 `gapsOverTolerance`（±3x）对"只丢一个点"是瞎的，两条判据互补，且各自的用例都验过：抽掉一行 → `singlePointHoles 1` 而 `gapsOverTolerance 0` → 红；干净文件 + 30 点边界残差 → 绿。
- **真机 100 Hz 下一直在静默丢掉 40% 的采样点，而 CSV 仍然声称 `SampTime(ms)=10`**：读线程的节拍门用 `last_selected.elapsed() >= rate_ms` 决定"这个点要不要"，而 `last_selected` 是在**选中之后的那一刻**重新赋值的 —— 那一刻已经比到达时间戳晚了几微秒到几十微秒（读返回、解析、offer 都发生在比较之前）。设备真实节奏实测 p50 10.00ms / p95 10.06ms，恰好等于请求周期，于是任何负抖动都让判据差几微秒地落空；一落空就要等下一个整周期，实测选中率塌到 **55~58%**（`offers 100.0/s selects 56.7/s`）。修复后是**固定网格 + 半周期宽限**：deadline 从上一步的网格点推进一个周期（不从"现在"重置），到达时间在 `deadline - period/2` 之后即放行 —— 宽限不改变长期速率（网格仍一步一周期），只改变 peak-hold 窗口的相位。真机复测 8 个 5s 窗口全部 `retention 100.0%`、`selects == offers == 100.0/s`，而 IPC 次数没有增加：740 次 emit 承载 4122 点（5.6 点/emit，修复前 698/2341 = 3.4）。**这条不是"变快了"，是"之前一直在丢数据"**：`retain_pending_sample` 的峰值保持让丢掉的那个点看起来无害（曲线照样平滑），但采样密度、能量积分和"100 Hz"这个声明都不成立。判据抽成纯函数 `stream::selection_deadline`，配 `a_device_paced_at_the_selection_period_is_not_decimated`：用实测分布造 2000 个确定性到达点，同一条 trace 同时喂旧规则（断言它**确实**丢掉 >25%，否则对照组无效）和新规则（断言留住 ≥99%）。承载这个区间的仪器是 `#[cfg(debug_assertions)]` 的 `stream::BusProbe`：`offers/s` 是设备给的，`selects/s` 是我们留下的，两者之差才是节拍门的代价；release 构建里这段代码不存在。
- **采集的"64 点或 8ms 合批"从来没发生过**：`stream::emit_loop` 的 deadline 从**第一个**点开始计时且不被后续流量延长，而选点节奏 `rate_ms ≥ 10ms`，所以 8ms 的固定窗口在稳态下永远只装得下开窗那一个点。100Hz 实测形状是 **1 点/emit、100 emit/s**（`bench/ui-runner.mjs` 浏览器侧与 `cargo test -p witrn-rs --lib -- --ignored --nocapture` 的扫描两侧一致），叠加每批一次的 JS ack，等于每秒 ~200 次主线程消息循环往返 —— 而 `app.emit` 在 Windows 上落到 `webview.eval` → `send_user_message`，每次都在抢那张正要绘制它的 rAF。现在窗口随采样率派生（`batch_window_ms = (rate_ms × 4).clamp(8, 50)`，50ms 是写死的延迟上限），100Hz 下 40ms 窗口 → **25 emit/s、4 点/emit**，往返降到约四分之一。`emit_loop` 的两条契约（deadline 从首点起算、不被流量延长）与 `BATCH_POINTS = 64` 容量上限原样保留，`Selection::finish()` 的排空路径不变；`stream.rs` 原有 8 个测试（含 5 万点无丢失无重复）全部原样通过，另加两条：一条纯函数测钳位区间与 `u64::MAX` 不溢出，一条按**比值**断言"同样的点数、flush 数至少减半"（用比值是因为 Windows 的 `sleep` 粒度会把标称节奏拉长，绝对阈值会假红 —— 实测把窗口退回常数时该断言报 17→15 flush 而变红，恢复后即绿）。`bench/ui-runner.mjs` 新增 `--emit-window-ms` 按 native 真实批形回放，旧的合并批形保留为默认，让既有列 SHA 断言继续跑
- **`bench:ui` 的 sustained 段把"浏览器没给帧"当成"我们丢了帧"**：rAF 间隔有两种成因，而间隔本身分不开它们 —— 于是被遮挡/节流的标签页会污染 `rafP95`、`drawP95`，并被 `estimatedMissedFrameSlots` 换算成成千个丢帧。一次 10s 实跑里出现过一个 **135,751ms** 的 rAF 间隔；另一次 20s 实跑（"20 秒"实际跑了 4 分钟墙钟，`wallRatio` 12.55）量到 `rafP95 = 121ms`，但同一轮 `preparationMs` 的 p95 只有 **1.6ms**、最大值 3.4ms、`longTasks` 为 **0 条** —— 我们自己的执行最多解释 3.4ms，所以那 121ms 里没有一个毫秒是本应用的。现在按**测出来的**上界（`cadence×2 + preparationMs.max`，不用魔法常数）把间隔分成"给到的帧"与"被饿到的帧"，新增 `rafOfferedMs`（同一轮 p95 = **6.2ms**，与标定节奏 6.1ms 一致）与 `timingTrust{starvedShare, suspendedMs, wallRatio, throttled}`，丢帧估计只统计给到的帧。计数类与工作类指标（`emitsPerSecond` 25、`meanPointsPerEmit` 4、`preparationMs`、列 SHA / `lastSeq` 断言）不受影响，因此仍然是可信的；这条同时把"`bench:ui` 计时永不进门禁"从约定变成有数字的理由。共享 runner 与日常开发环境都无法保证 Edge 全程前台，所以选择标出不可信而不是把数字修饰干净
- **改完前端忘记构建，cargo 会静默编译进上一版字节**：`generate_context!` 内嵌的是 `frontendDist`（`out/`），而 `tauri-build` 只把 `frontendDist` 声明成 `rerun-if-changed` —— 于是 `cargo test` / `check` / `clippy` 既不会重跑 build script，也不会重跑 CSS 合并，改过的 `src/` 与编进去的字节可以无限期不一致，而且**是一次成功编译**。这不是理论风险：`beforeDevCommand` / `beforeBuildCommand` 只在 `cargo tauri dev|build` 下生效，本仓库日常一半的 cargo 调用（测试、lint、CI 的 Rust job）走不到它。现在 `src-tauri/build.rs` 把 `src/` 下每个会被镜像的文件逐个声明成 `rerun-if-changed`，再比较两边最新 mtime，`src/` 更新就 panic 并给出"先跑 `npm run build`"。排除规则与 `build-dist.mjs` 的 mirror 一致（`.d.ts` 与点号目录不进 `out/`），两侧都写了注释指向对方。四条实测行为：`touch src/styles.css` → 报；`touch src/global.d.ts` → 不报；`npm run build` → 报消失；`out/` 整个不存在 → 报（比原来宏展开期那句 `! failed to read ...` 更早也更可解释）
- **release 的 `lto` 被实测否掉**：原计划加 `lto = "thin"`，量下来它是被严格支配的选项 —— 比完全不开 LTO **又大又慢**（`lto=false cg=1` 重链 127.3s / 13,069,312 字节，`lto=thin cg=1` 171.1s / 13,421,568 字节）。镜像尺寸真正的来源是 `codegen-units = 1`（14,238,720 → 13,069,312，−8.2%，重链 82s → 127s），它过了本仓库给自己定的「>5% 才值得」的线，所以留下；`lto = "fat"` 只再省 2.2% 却把冷构建推到 240.7s，不过线，也拒。结论与配置理由连同数字一起写进根 `Cargo.toml` 注释，避免下一轮凭印象重加
- **拖时间轴时画的不是松手后那张图**：拖动中主图改绑「按全量历史分条带」的概览桶（`ppb = ceil(n / 宽度)`），松手才换成「按可见窗口分条带」（`ppb = ceil(windowCount / 宽度)`）。窄窗口嵌在长历史里时两者条带宽度差几十倍 —— 实测 20 万点的历史拖到 2001 点的窗口，拖动中窗口内只有 24 个顶点，松手后跳到 2002 个；跨过 `SPLINE_MAX_POINTS = 1000` 时连 spline↔linear 都会翻面。现在删掉概览桶与预览分支，`bindDisplayData` 是「画什么」的唯一定义，拖动中每帧都按当次窗口重算。代价实测：1M 点历史、1200px 宽，最密窗口 4.2ms/帧、600k 窗口 3.6ms、100k 窗口 2.0ms（帧预算 16.7ms），而这笔钱原本就花在松手那一帧
- **放大后的画面会在录制中自行变稀**：`SeriesBuckets.rebuild` 把 `cap` 原样留给增量合并，而重建出的条带数往往正好等于 `cap`，于是**落进下一个新样本就触发 `mergeDown` 把整表分辨率腰斩**，之后靠 `cap === cap` 的快路径再也不会重扫 —— 没人操作时曲线一档档变糙。改为 `rebuild` 后留一倍合并余量，分辨率的合法变化只由「`ppb` 与窗口算出的 `stripePpb` 不符 ⇒ 整体重建」决定
- **标题栏初始化被 TypeError 整段打断**：`guardDecorumSnap` 给 `window.__TAURI_INTERNALS__.invoke` 赋值，而该属性是只读的 —— `TypeError: Cannot assign to read only property 'invoke'`。`initWindowControls()` 因此在 `restyleDecorumButtons()` 之前中断，并沿 `setupShell()` 冒泡出 `app.js` 那个没有外层 `try/catch` 的 `DOMContentLoaded` 异步处理器，把后面的 `applyPdSplitLayout()`、`updateChartEmptyState()`、`setupEventListener()`、`refreshDeviceList()` 一起静默跳掉（unhandled rejection）。改为不再 monkey-patch IPC，而是在源头取消插件自己那个 620ms timer
- **macOS 风格红绿灯黑角**：黑角不是色点描边也不是图标字号，而是 decorum 写进按钮 `innerHTML` 的 `\uE9xx` 私用区字形 —— 它按插件注入的 `font-size: 10px` 绘制，又被皮肤规则染成 `var(--black)`，10px 方框半对角线 7.07px > 色点半径 6px，✕ 与 □ 的四角戳出圆外（− 是横杠所以看不出来）。上一条 TypeError 正是它没能被 SVG 图标替换掉的原因；此外 macOS 皮肤的按钮补上 `font-size: 0`，让皮肤不再依赖替换是否成功。符号尺寸同时收进 `--window-mac-control-symbol`（7px），色点 `::before` 补 `inset: 0; margin: auto` 写实居中（原先只靠「abspos flex 子项取静态位置」，WebKit 不遵守）
- **macOS 皮肤下仍弹 Win11 贴取布局浮窗**：改为在 `#decorum-tb-maximize` 自身上后注册一个 `mouseenter`，macOS 皮肤下同步补发 `mouseleave`，让插件自己的 `clearTimeout` 生效。注意委托到 `document` 的捕获监听**收不到** `mouseenter` —— Blink 把 enter/leave 只派发给目标元素，"不冒泡"是这么实现的；同节点上注册顺序即调用顺序，我们晚于插件，timer 已写入
- **macOS 风格设置钮贴边**：窗口控制挪到左侧后设置钮成为标题栏最右一项，右侧没有任何内缩。补上与左侧交通灯对称的 12px `padding-right`
- **拖动读数栏后图表永不再定尺**：分栏手柄只绑 `pointerup` / `pointercancel`，而指针捕获被其他手柄抢走时浏览器只发 `lostpointercapture`，标志便卡在 true，`flushResizes` 从此永久早退且无 `window.resize` 兜底。补上该事件（与两个时间轴手柄一致），并把标志清除提到提交之前
- **`<select>` 箭头的 `data:` URL 被发货 CSP 拦下**：`img-src` 是 `'self' asset: https://asset.localhost blob:`，不含 `data:`，而 `src/styles.css` 里两个下拉箭头用的是内联 `data:image/svg+xml`。用 `bench/ui-runner.mjs --shipped-csp`（新增，见 Added）在真实页面上收到 `securitypolicyviolation`：`directive: img-src`、`disposition: enforce`。改为两个真实文件 `src/assets/select-arrow-{dark,light}.svg`（颜色逐字保持 `#d6d6d6` / `#424242`），违规数归零。**注意不要把它读成"箭头一直是坏的"**：`enhanceSelects()` 会给原生 select 加 `.cs-native` 并收成 1×1px，所以对已增强的控件这个箭头本来就不参与视觉；未被增强、以及增强之前的那一次绘制才是违规来源。修的是"发货策略下存在被拦资源"这件事本身，不是可见性
- **CI allowlist**：`macos-private-api` 与 `tauri.conf.json` 的 `macOSPrivateApi` 对齐，Linux / Windows 上 `cargo clippy` / `cargo test` 不再被 tauri-build 拦下

### Changed
- **大数据量下的响应性改造（三个阶段，完整对照与原始记录见新增的 [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)）**：目标是把「大数据量操作时界面不卡住、原始数据不丢失」做实；原始采样点未降精度或删减，显示分桶只改变提交给图表的绘图顶点。① UI：监控视图隐藏时推迟局部绘制与 DOM 更新、恢复时补齐（采样、统计与积分照常进行），跳过未变化读数的重复 DOM 写入，图表更新经 rAF 合并调度、按优先级先解决范围与卡片状态再让图表读窗口；② 计算：范围统计、导航图冷准备、极值索引与大窗口投影改为分片执行并主动让出主线程，CSV 解析、稳定排序、统计与积分移入模块 Worker，PD 筛选与行布局分片且保持增量追加；③ 存储：11 个连续、倍增扩容的 `Float64Array` 列改为每块 4096 点的分块列，录制前为整行预留空间，图表、统计、CSV、积分都从块读取，稀疏窗口只把可见原始点及相邻点复制给 uPlot。同机有窗口 Edge 的端到端对照：500 万点图表冷准备的最大主线程等待 235.3 → 5.0 ms（长任务 7 → 0）、500 万点范围统计 55.5 → 5.0 ms、30 万行 CSV 导入 246.9 → 11.7 ms、100 万条 PD 筛选 119.9 → 5.7 ms；分块存储把 11 列追加 25 万点从 188.4 ms 降到 25.1 ms、500 万点追加后的列缓冲从 880 MB 降到 462 MB。代价照实说：部分操作总完成时间变慢（500 万点统计 +44.8%、30 万行 CSV +30.5%），分块列的范围统计约慢 45%（54.0 → 77.5 ms），分块并未实现恒定内存录制 —— 定性结论是响应性大幅改善、吞吐量有明确代价，不能概括成「所有场景都更快」。范围统计异步化后计算状态可见：进行中的读数显示 `--`，实时读数栏顶部标注「统计范围 a – b（更新中）」。
- **工作区 `rust-version` 1.75 → 1.85**：`crates/km003c` 的 `nusb 0.2` 要求 1.85；README 徽章、`docs/DEVELOPMENT.md`、`docs/ARCHITECTURE.md` 同步。
- **能量积分的空档阈值改为随标称采样间隔定标**：`max(2 s, 8 × 间隔)`。500 ms 档从 2 s 放宽到 4 s、1 s 档到 8 s、5 s 档到 40 s、10 s 档到 80 s（250 ms 档恰好仍是 2 s，未变）。这意味着慢档下一次真实的 3 – 30 秒丢帧现在**会**被积进能量 —— 是口径变化，不只是修 bug；原来的绝对 2 秒在慢档下等于「永远不积分」，两个读数里没有一个是对的。倍数取 8 是为了和 x 轴 `nextRecordingX` 用同一个常数，否则两条轴又会各自解释同一个空档。
- **`.gitignore` 与 git 索引曾经不一致**：`src/.playwright-cli/page-*.yml` 早已列在忽略规则里，但它在 `d0f46fe` 就被提交过 —— `.gitignore` 对**已跟踪**文件无效。已 `git rm --cached` 取消跟踪（文件留在磁盘上，`git reset` 可完全撤销）。它 0 字节，所以这是"规则失效"的证据而不是体积问题；`bench/packaging.mjs` 现在会同时区分**已跟踪但无人引用**（白占所有用户体积）与**未跟踪但会被内嵌**（本机二进制无法由干净检出复现）两类
- **dev 下依赖跑 opt-level 2**：根 `Cargo.toml` 新增 `[profile.dev.package."*"] opt-level = 2`。此前 `cargo tauri dev` 里 `serde_json` / `hidapi` / 解析器 / 整条 emit 链全跑未优化代码，比 release 慢数倍，**任何在 dev 下取的启动或首帧数字量的都是假象**。代价说清：首次 dev 构建会重编全部依赖（多几分钟，一次性），之后每次 relink 不变。按用户选择保留完整 `debug`（不上 `line-tables-only`），Rust 断点看变量值的能力不受影响
- **`crate-type` 收成一个 `rlib`**：`staticlib` 与 `cdylib` 是 mobile 的链接形态，而仓库里既没有 `gen/android` / `gen/apple` 也没装任何 mobile target，`main.rs` 只调 `witrn_rs_lib::run()`。实测一对交替比较：只碰 `lib.rs` 的 `cargo build` 重链 **4.35s vs 6.34s**（切换后首次构建要冷建那两个额外链接形态，约 19s）。收益不大，但它在每天那条路径上且在此换不到任何东西
- **`bundle.targets` 从 `"all"` 改为显式列出**：目的是可复现性而不是速度 —— `"all"` 意味着上游将来新增任何打包格式都会静默进入构建矩阵。README 向用户同时承诺了 `.msi` 与 `.exe`(NSIS) 两条渠道，所以**没有**收窄集合；本地想快请用 `cargo tauri build --bundles nsis`（跳过昂贵的 WiX candle/light）或 `--no-bundle`
- **删掉从未被使用的 Codicons 字体**：`src/assets/codicon.ttf`（123,192 字节原始大小）在 `src/` 里没有任何 `@font-face` 或 `url()` 引用，唯一提到 "codicon" 的地方是 `src/ui/menu.js` 里一条永远匹配不上的 `/^codicon-/` 字符串剥离 —— 实际所有 `icon:` 取值都是裸名（`pulse` / `export` / …），既不带 `fi-` 也不带 `codicon-` 前缀。它进二进制只是因为 `tauri-codegen` 的 `WalkDir` 会递归扫整个 `frontendDist`。不要把它记成"省了 123KB"：内嵌资产本来就被 brotli 压缩过
- **`bench/` 的受门指标换成活路径**：`measurement.calculateEnergy.ms` 退出计时与门禁（`calculateEnergy` 在生产里没有调用点，只有 `calculateEnergyInRange` 经 `src/csv.js` 活着；给它上锁等于给一个没人调的函数设卡），改为 `integrateEnergy.nullSegments`（实盘 `segments` 恒为 null 的那条）与 `integrateEnergy.withSegments`（带 `recordingSegments` 列的 CSV 导入真正付的那条）。`calculateEnergy` 仍留在 `golden()` 的正确性对照里。`SeriesBuckets.flatten.reused` 原来在 1M 下 p50 报 `0.0001ms`（亚微秒；门禁文件里放一个近似 0 的数比不放更糟 —— 会有人拿它做除数），改为一次测 32768 次再折算，并让 `projectBaseline` 在测量块低于 0.2ms 时直接拒绝而不是写入噪声
- **未使用但已跟踪 / 未跟踪但会被内嵌，两类问题分开报**：`bench/packaging.mjs` 实测抓到 `src/.playwright-cli/page-*.yml` 虽在 `.gitignore` 里却**已被跟踪**（`.gitignore` 对已跟踪文件无效，它在 `d0f46fe` 就被提交进来了；该文件 0 字节，所以它是规则失效的证据而不是体积问题），同时抓到 `chart-extrema.js` / `csv-codec.js` / `device-stream.js` / `window-style.js` 四个**未跟踪**文件 —— 意味着 `target/release/` 里那个二进制无法由干净检出复现
- **极值金字塔降为纯速度选择器**：`extremaForStripes` 只回答「这次折叠用金字塔 fold 还是逐样本扫」，两条路径对同一条带产出同一组 min/max（`bench/extrema.mjs` 在 1 万 / 10 万 / 100 万三档、5 个非对齐起点上逐桶 `deepStrictEqual`；`test/chart-extrema.test.js` 补了条带宽度跨 `BLOCK_SIZE` 上下的那一档）。门槛从 `ppb ≥ 128` 改成「已 warm 时 `ppb > 32` 即可复用，冷建仍只留给 `ppb ≥ 128`」—— 冷建是 O(全量) 的一次性开销（实测 1M ≈ 30ms、5M ≈ 118ms、常驻 8–51MB），不能为一个窄窗口去付
- **`plotCssWidth` 换算自洽**：`bbox.width` 是设备像素，旧代码除以 `uPlot.pxRatio`，而 vendor 包里 dppx 监听只改这个静态值、没有 `setPxRatio`，每张图的换算比在建图时就烘死了 —— 改系统缩放或换屏后得到一个既不是旧宽也不是新宽的宽度，条带密度跟着算错。现在除以 `canvas.width / chart.width`（渲染真正在用的比值），画布陈旧时它一起陈旧，密度仍匹配正在显示的画面
- **拖动范围时统计与能量数字不再停在旧窗口**：`applyRangeValues(preview)` 早退时跳过了 `scheduleStatsUpdate()`，曲线已经换窗而数字还是上一个窗口的最小/平均/最大。改为照常调度（该函数本身 250ms 节流，滚轮路径早就这么做了）
- **PD 分栏手柄补齐捕获释放**：`initSplitter` 只绑 `pointerup` 且 `pointermove` 只看 `pointer !== null`。指针捕获被别的元素抢走时浏览器只发 `lostpointercapture`，`pointer` 便永不归零，之后裸移动鼠标会继续改写 `--pd-list-basis`。补 `pointercancel` / `lostpointercapture` 并改用 `hasPointerCapture` 守卫（与监控页分栏一致，`test/layout-resize.test.js` 的契约同时扩到 `src/views/pd.js`）
- **构建文档的产物路径**：workspace 根在仓库根，cargo 只写 `target/`，`src-tauri/target/` 并不存在。`docs/DEVELOPMENT.md` 与 `docs/MACOS_BUILD.md` 共 8 处路径改正，并说明 `frontendDist` 未配 `devUrl`、改 `src/` 需重新编译
- **macOS 构建文档**：从仓库根目录迁入 [`docs/MACOS_BUILD.md`](docs/MACOS_BUILD.md)，README 与开发文档增加引用

### Removed
- **窗口材质（Mica / 非聚焦材质）整体移除**：窗口不再透明 —— `transparent: false`、底色 `#1f1f1f`，删除 `window-vibrancy` 依赖、`window_material` 模块与 `get_window_material` / `set_window_material_theme` / `set_window_material_enabled` / `set_window_material_unfocused` 四条命令；设置页「外观」不再有「窗口材质」开关，旧配置里的遗留键（`windowMaterial` / `windowMaterialUnfocused`）在加载时被丢弃且不影响其余设置；`boot_timing` 的 `material_applied` 阶段一并移除。

## [0.2.1] - 2026-08-29

### Added
- **非聚焦窗口材质**：设置 → 外观在「窗口材质」下新增「允许非聚焦窗口使用窗口材质」。开启后失去焦点仍保持 Mica，不再回退纯色
- **图表滚轮横向缩放**：在主图上滚动以光标为锚缩放时间窗；录制中可用。右沿贴着最新数据时跟最新走（固定时长），否则定住历史片段。时间线滑块同步，暂停后再继续不会丢掉已缩的窗
- **时间线选区可平移**：拖动导航条中间高亮范围可整体移动窗口（跨度不变）；两端手柄仍负责缩放
- **Windows 11 Mica 窗口材质**：设置 → 外观新增「窗口材质」开关（默认开，仅 Win11 可用时显示）。远程桌面或录屏下若透底，可关掉改回不透明底色
- **读数栏仪表化**：电压/电流/功率/温度主卡为标题 + 圆角横向电平条（包住大字读数）+ 最小/平均/最大三列；能量与信号线卡为水平迷你条；量程按会话观察最大值走 1-2-5 取顶。最小窗口（900×600）连温度卡也一屏完整露出
- **监控读数栏可拖宽**：右侧分栏条 200–360px，默认 250px，宽度写入配置
- **命令栏溢出菜单**：宽度不足时把导出 CSV / 导入 CSV / 一键重置收进 `⋯`，不再一刀切把整栏图标化
- **PD 分栏方向**：宽屏（≥1400px）可改为左右分栏，偏好持久化
- **状态栏时长与采样率**：记录状态可点击启停；新增累计时长与当前采样率
- **PD 厂商名**：Vendor Defined 的 VID 在列表 Note 与详情里显示 USB-IF 厂商（如 `0x05AC [Apple]`）；未登记写 `[Unknown Vendor]`。SVID（含 PD SID `0xFF00`）保持十六进制

### Changed
- **大窗口高速记录更跟手**：显示桶改为每 CSS 像素一对 min/max；录制中桶路径也能在 Y 极值未破时跳过四轴量化；导航图约 10 Hz 刷新；flatten 复用 typed array；超预算时按约 30fps 让帧
- **读数主卡横向电平**：电压/电流/功率/温度的当前读数改为圆角横向电平条（底色与填充为同一通道不同色度）；数字居中并占满条面；标题恢复通道色圆点，卡内文字用常规文本色
- **图表次网格**：两个主格线之间由对分改为 5 等分
- **标题栏连接区**：`连接` / `断开` 合并为单颗状态按钮，拖拽区加宽
- **图标体系**：界面图标从 Codicons 换成 Fluent System Icons（MIT）
- **轻量分层**：卡片补 elevation 与暗色顶边高光；PD 行 hover 与 Tab 下划线改为短 CSS 过渡，不加 JS 动画
- **设置页二态控件**：窗口材质、记录电流方向改为 ToggleSwitch；滚动条默认更淡，容器悬停时加粗显形
- **移除内建 Maple Mono**：等宽英数与中文改走各平台原生字体。Windows：界面 Segoe UI Variable Text / Segoe UI + 微软雅黑，等宽 Cascadia Mono / Consolas；macOS：界面 -apple-system / PingFang SC，等宽 SF Mono / Menlo；Linux：界面 system-ui / Noto Sans CJK SC，等宽 `ui-monospace` / Noto Sans Mono。`html[data-os]` 提前到 `theme-boot.js`，首帧即选对字体栈。
- **图表列只保留 `chartSeries`**：去掉与之同对象的 `chartData` 别名

### Fixed
- **Windows 窗口按钮方块字**：部分 Win10 缺少 Segoe Fluent Icons / MDL2 时，decorum 私用区字形会显示成方块。保留 decorum 按钮与贴靠浮窗，内容改用内置 Fluent SVG
- **读数栏排版**：大字读数左对齐并用 `tabular-nums`；最小 / 平均 / 最大三列改为左 / 中 / 右对齐，不再被省略号规则套到内层数字上
- **窄窗读数栏过宽**：小窗口下侧栏仍按 250px 计，主卡右侧留白过大。视口 <1080（或高度 <620）上限 220px，<980 上限 200px。被上限卡住时拖动分栏不再改写大窗口下的宽度偏好
- **拖动读数栏卡顿**：分栏拖动期间跳过图表的 `ResizeObserver`，宽度写入合并到 rAF，松手后再 `setSize`
- **导入 CSV 后仍显示「暂无数据」**：`importCSV` 写完列数据后补一次 `updateChartEmptyState`
- **Mica 不可见、深色发蓝**：WebView 画布改为全透明，`color-scheme` 从 `:root` 下沉到 `.app-shell`，浅色主题不再盖掉 Mica 令牌；外壳用中性灰半透明罩层。开 Mica 时优先 `apply_tabbed`（Mica Alt）
- **导入 CSV 不再改采样率**：文件里的相对秒已是 x 轴；继续记录用当前设置的间隔，`SampTime` 只作元数据
- **开始记录连点**：`set_pd_capture_enabled` 完成前拒绝重入
- **PD 导入 / 清空世代**：meta-only 导入等待 `pd_log_clear` 的新 generation；清空失败不再把闸门钉在 `-1`；补洞与 `pd_log_replace` 长度不一致时不再丢掉已成功的后端日志
- **自动暂停 duration=0**：阈值一满足立即暂停
- **导入能量跳过休眠空档**：相邻点间隔超过 2 秒不积进 Wh/mAh
- **重置设置后自动暂停单位**：`#ap-unit` 与阈值单位一并回显
- **损坏配置 `rangeStart > rangeEnd`**：分别钳位后交换
- **窗口按钮 Promise**：最小化 / 最大化 / 拉伸失败不再变成未捕获拒绝
- **Flyout 滚动关闭**：与下拉菜单一致，外部滚动时收起
- **连接连点**：HID 与温度服务各自加 in-flight 锁
- **PD IPC 背压**：通道满时 pending 最多 256 条，日志不丢；拔线改 `try_send` 并排空后再发断开
- **采样节流**：通道 Full 时不推进 `last_emit`，下一轮立即重试
- **打开失败**：已拆掉旧会话时清空设备信息并通知断开
- **`pd_unpack`**：拒绝非 `0xFE` 报告头

### Security
- **收紧 capability 与 CSP**：`dialog:default` 收窄为 `dialog:allow-open` + `dialog:allow-save`（应用内确认框走 `<dialog>`，不再授权原生 message/ask）。CSP 的 `script-src` / `style-src` 去掉 `'unsafe-inline'`。已在 Windows WebView2 上验证；Linux GUI / WebKitGTK 未做运行时冒烟。

### Removed
- 内建 `MapleMono-NF-CN-Regular.ttf` 及对应 `@font-face`
- Codicons 字体与 `codicon.css`（改用 Fluent System Icons）
- **仪表签名 / 指纹**：设置页「读取设备身份」、Tauri `identify_current_device`，以及 `witrn-hid` 的 `info.rs` / `identity()` / `identify` example。设置页仍显示 HID 枚举的 VID/PID/SN；USB-PD Discover Identity 报文解码保留
- 按 VID/PID 连接的 `connect_device` 命令（两台同型号会连错；前端只用 path）

## [0.2.0] - 2026-08-23

### Added
- **U3 识别 PID 0x5044**：实测到另一款 U3 固件变体上报 `0716:5044`，原先只认 `0x5063`，标题栏设备下拉会显示「未知 WITRN 设备 (0716:5044)」。现与 C5 一样按双 PID 识别为 WITRN U3
- **浅色主题与跟随系统**：设置 → 外观，主题三档深色 / 浅色 / 跟随系统（默认深色，已有配置不受影响）。浅色只重赋 `tokens.css` 语义层；偏好随配置持久化，并镜像到 `localStorage` 供首屏同步生效，避免异步读设置时闪暗色。跟随系统时监听 `prefers-color-scheme`，OS 外观变化即时切换
- **自定义界面缩放**：设置 → 外观，50%–200%（步进 5%）等比缩放整页（含图表与自定义标题栏）。主路径走 Tauri `webview.setZoom`，API 不可用时 CSS `zoom` 回退并补偿 `100vh`。默认 100% 跟随系统 DPI；系统缩放偏大、逻辑视口过小导致过早进入紧凑档时，把本项调低即可。随配置持久化，重置配置回到 100%
- **PD 协议分析工作区**：接入 `pd-data-batch` 事件，报文列表带时间戳、SOP/SRC/SNK/CBL 徽章与 PDO/RDO 速览摘要，点击行在下方详情面板渲染逐字段解码（hex / Header 表 / PDO 位域）；支持暂停缓冲、清空、按消息类型过滤、隐藏 GoodCRC（默认开）、自动滚动开关；可增长日志 + 虚拟列表 + rAF 窗口同步，视图隐藏时跳过 DOM 工作
- **设备信息（设置页右栏）**：接入后端已有的 `identify_current_device` 命令，读取产品名、批次序列号与端口无关稳定指纹；录制中禁用（该命令会暂停数据流约 2 秒）；VID/PID/SN 从工具条迁入此处
- **ID 契约测试**（`test/ids.test.js`）：从 JS 源码提取全部 `getElementById` 字面量，断言每个 id 在 index.html 恰好出现一次，防止结构重排"移丢"控件；**PD 纯逻辑测试**（`test/pd-model.test.js`）覆盖摘要提取、过滤与虚拟列表窗口切片
- 活动工作区持久化（`settings.activeView`，白名单校验），启动恢复上次 Tab
- **D+/D-/CC1/CC2 信号线**：设备载荷中的四路信号线电压（后端一直在推送，前端此前丢弃）纳入数据模型——侧栏新增「信号线」卡实时显示（0.01V 分辨率）；「显示」浮出面板新增 D+/D- 与 CC1/CC2 两个开关（默认关），开启后以细线叠加到图表并复用电压坐标轴（电压曲线隐藏时轴量程聚合叠加曲线，轴不消失）；CSV 导出在 Temp 后追加 `D+(V),D-(V),CC1(V),CC2(V)` 四列，导入按表头名定位列、新旧格式自动兼容（旧文件信号列记为缺失）
- **记录电流方向**（设置 → 图表与记录，默认关）：开启后正向记录为正、反向为负（K2 电流源头带符号 ±10A，此前一律取绝对值），电流轴自动向负半轴扩展同比例余量；侧栏电流数值恒为幅值、方向以 →/← 箭头指示（不用正负号）；CSV 导出跟随记录值（开=带符号，关=绝对值），导入按同一规则处理；能量积分与自动暂停阈值恒按幅值，方向切换不改写已有数据
- **PD 捕获导入 / 导出**：PD 命令栏新增导出/导入按钮。导出为版本化 JSON 封套（`kind: pd-capture` / `version: 2` 紧凑日志，含原始帧；无帧时回退带解码树），v1 整树文件仍可导入。导入前确认替换、逐条校验结构（含递归深度上限）；v1 从解码树重算列表摘要
- **摄入与捕获测试**：`test/ingest.test.js`（有符号电流开/关的存储与统计、信号线列对齐、能量恒正）、`test/pd-capture-state.test.js`（采集状态机与 ingest 门控一致性）、`test/pd-capture-file.test.js`（捕获文件往返、摘要重算、畸形输入与深度上限拒绝）、`test/pd-clear-linkage.test.js`（跟随记录开/关时清空的级联与确认文案，走真实的 `ask` 回退路径）、`test/measurement.test.js` 扩展（CSV 表头列映射四种格式）

### Changed
- **设置页改成主栏列表 + 侧栏**：外观 / 图表与记录用「标题 + 说明 | 控件」行排进分组卡片，主题与纵向余量改成分段选择；宽屏右侧放设备信息与关于，窄屏收成单列。VID/PID/SN 改为只读定义列表，不再用只读输入框。
- **高频记录 + PD 同时开时图表跟手**：HID 读线程与 IPC 发射线程拆开，`pd-data` 改为按帧合并的 `pd-data-batch`（报文一条不丢）；采样率改为 `AtomicU64`，读循环不再每圈抢锁。主图在可见窗口超过 2×宽度后改送增量 min/max 像素桶（全量仍在 `F64Col`，悬停二分回原始点），绘制预算最多让一帧。记录中侧栏数字并入 rAF。PD 列表按行补丁复用，切回时用 `pd_log_after` 按 seq 补洞。Windows WebView2 打开 GPU 栅格，图表 canvas 提到合成层。
- **Y 轴标题改到轴顶横向放置**：电压 / 电流 / 功率 / 温度不再竖排贴在轴侧；贴边轴的标题从竖脊朝图内伸出，外侧轴贴画布外沿，避免同侧双轴在 30px 轴沟里叠字；左右不再为竖排字预留 `labelSize`，绘图区变宽
- **监控通道色改走鲜艳阶**：电压/电流等曲线与侧栏读数从 `Foreground2`（tint40 / shade30）改到官方 shared 色板的 tint20 / primary（lightBlue、seafoam、orange 等），选区与状态点同步提高饱和度；壳层与 PD 徽章仍用上一轮的 alias。
- **配色对齐 Fluent UI Theme Colors**：`tokens.css` 原始色换成官方 grey / brand / shared 色阶，语义层按 webDark / webLight alias 重赋（表面、文本、不透明填充与描边、品牌实心钮与复合强调、cranberry/green/orange 状态色）。通道与 PD 徽章改走 `colorPalette*` Background2/Foreground2，浅色主题不再沿用暗色曲线色。图表网格改为中性描边令牌。
- **实时采集流畅度**：主曲线存储改为可扩容 `Float64Array` 列（uPlot 零拷贝 `subarray` 视图），避免普通数组扩容拷贝与装箱扫描；流式绘制按上一帧耗时做预算（超过约 10ms 则只入库、有空再画最新全量；记录中侧栏数字并入 rAF，未记录时仍逐点刷新）；Y 极值未破时 `setData(..., false)` 只推 X 右沿。监控 Tab 切走后不再 `setData`/`setSize`，画布用绝对定位保几何，回来不叠两三次全量重绘。画面算法不变（稀疏 spline+填充，密集 linear+填充），不丢点、不做肉眼可辨的降采样。
- **状态栏去掉设备名**：顶部连接区已有设备下拉，底部不再重复显示型号。
- **PD 分析记录不再 2000 条封顶**：可增长日志 + 虚拟列表（只挂视口附近的行），存储与 DOM 解耦；跟随记录门控不变。后端以紧凑的 `pd-data-batch` 下发（摘要 + 原始 HID 帧），解码树留在 Rust，点选时 `decode_pd_at` 按索引直接取出（含会话上下文，不重放 Parser）。捕获文件默认 v2，v1 整树文件仍可导入；导入不再截断。超过 50 万条 toast 警告，默认继续存储。
- **图表记录单份列式存储**：`chartData` 与 `chartSeries` 指向同一组列，去掉电压/电流等通道的双份拷贝。导航图改为宽度级 minmax 桶（新点只更新最后一桶，超上限两两合并），不再对全历史功率列每帧 `setData`。CSV 导出按列一遍拼行后一次写出。范围统计在全历史窗口增长时只折入新尾段。
- **界面全面重构为 Fluent 2 多 Tab 工作区**：仿 Office Ribbon 单页布局（默认窗宽即横向溢出）替换为 监控 / PD 分析 / ⚙设置（含设备信息）工作区 Tab；每个工作区容纳"主功能 + 自身设置"（显示通道、自动暂停、温度服务收进监控页命令栏的浮出面板），设备连接区常驻标题栏、任何页面可快速连断；底部新增全局状态栏（记录状态/点数/连接状态）。视图切换用 `hidden` 属性、监控视图常驻挂载，uPlot 实例跨切换存活
- **设计令牌层**（`src/styles/tokens.css`）：原始色 → 语义角色 → 组件旋钮三层结构；表面分层（壳/内容/卡片/弹层）、统一圆角（控件 4px / 表面 8px）、Fluent 阴影四档与动效曲线、跨平台中文字体回退；亮色主题只需重赋语义层。曲线颜色改由 `src/theme.js` 从令牌读取，修复图表曲线色与复选框/卡片色不一致的问题（图例点 = 复选框色块 = 卡片强调条 = 曲线同源）
- **自定义标题栏**：`decorations: false`，Tab 条 + 连接区 + 窗口按钮合并为一行（Windows Terminal 形态）。Windows 经 `tauri-plugin-decorum` 注入窗口按钮并保留 Win11 贴靠布局浮窗（按设计令牌重绘）；Linux 自绘窗口按钮 + 四边/四角透明热区调 `startResizeDragging()` 实现无边框调整大小，1px 描边补偿无阴影轮廓
- **对话框体系入前端**：6 处确认框（退出、重置配置、一键重置、CSV 导入、PD 清空、PD 导入）迁移到基于 `<dialog>` 的应用内确认框（签名与 tauri 插件 `ask` 一致；无 `HTMLDialogElement` 的旧 WebKitGTK 透明回退插件实现），10 处阻塞式 `window.alert()` 全部改为右下角非阻塞 toast（错误常驻、其余 4 秒自动消失）；文件选择器保留原生（Tauri v2 经对话框选择授予所选路径的 fs scope）。导出菜单与新增菜单统一为 `src/ui/menu.js` 原语
- **窄窗口适配改为分档紧凑布局**（`styles/compact.css`，纯响应式媒体查询）：固定 px 布局在窗口低于设计基准（1280×800）时，旧行为是命令栏横向滚出视野、状态栏静默截断、标题栏内容滑入 decorum 窗口按钮下方——功能"看不见"甚至被遮挡。现在按各区域 min-content 实测分档收紧：视口 <1080 收紧间距、侧栏 230→200px，把空间还给图表；<980 命令栏图标化（每键补齐 title 保留语义；自动暂停 / 温度服务 / PD 暂停等状态承载按钮保留文字），设备下拉收窄、连接状态只留指示点；高度 <620（最小窗高 600 与低分屏最大化如 1366×768 @125% ≈577 都会进入）时间轴收为 64px、图表下限 240px，纵向 min-content 降到约 433px；<900 Tab 图标化、<700 收紧 PD 表列与复选框文字（极端 DPI 下 OS 给出的窗口可小于 minWidth，以及浏览器调试）。文字始终 13px 原生尺寸，不做任何缩放；布局尺寸下沉为 `tokens.css` 组件旋钮，紧凑档只重赋变量
- **图表网格重做为两级层次 + 四轴严格共线**：此前只有电压轴画横网格（`rgba(74,158,255,.22)`，在卡片底色上几乎看不见），温度轴靠比例映射电压刻度再取整（取整即偏离网格线），电流/功率轴完全没有对齐逻辑；每格再细分 4 条 0.5px 细线，结果是"又密又糊"。现在全部 Y 轴共用一个等分数 N（按绘图区高度约 80px/格取 3–7 档，只随窗口变化不随数据抖动），各轴量程量化为「整齐步长 × N」后用 `min+(max-min)·i/N` 出刻度——第 i 条刻度在四条轴上落在同一像素行，网格线交给 uPlot 自己画，刻度与网格天然重合；顶部刻度正好压在绘图区顶边。网格色收敛为两个不透明令牌 `--chart-grid` / `--chart-grid-minor`（走 `--stroke-control` / `--stroke-divider`；不透明是必须的：四条轴重复描边，半透明会叠亮），次网格由每格 4 条降为 1 条中线、线宽 0.5→1px，主刻度间距不足 36px 时不画。副作用（正向）：隐藏电压曲线后横网格依然在位；不再依赖 uPlot 私有字段 `axes[1]._splits` 做纵向对齐。量化代价是纵向余量可能比设置值多出至多一个步长
- **坐标轴强化**：电流/功率/温度轴补上通道色刻度线（此前仅电压轴有刻度与网格，其余三轴只有数字）
- **图表纵向余量可配置**（设置 → 图表与记录）：默认「自动」预留约 25% 顶部空白让曲线保持中高位置（原为硬编码 5%，曲线顶边），「自定义」可在 0–100% 间调节；主图四轴与导航图同步遵循
- **记录页侧栏紧凑化**：卡片内边距与行距收紧、数值字号 32→24px（矮窗档再降到 20px），功率/温度卡的「平均」由独占一行改为并入标题行右侧（那行原本只有两个字，右侧全是空白），min/max 行保持对开两列不挤成三列裁数字。实测 900×600（最小窗口）连着温度服务时六张卡共约 423px、面板可用 481px——最小允许窗口下也不再出现滚动条（`overflow-y: auto` 与卡片 `flex-shrink: 0` 保留作兜底）
- **PD 分析采用上列表 + 下详情分栏**：点击行在下方渲染完整解码树，选中态在过滤/切页/恢复暂停后保持，↑/↓ 键在报文行间导航（跳过断开分隔行）
- **记录控制合并为一个强调按钮**：「开始记录」+「停止」两颗无强调的 ghost 按钮合并为单颗 `#btn-record-toggle`，也是命令栏里唯一的实心按钮——未记录时强调色亮蓝底 + 录制点图标，记录中切红底 + 暂停图标（图标不单独配色，一律继承按钮文字色，与文字始终同色），未连接设备则禁用并提示「请先连接设备」。文案随状态在 开始记录 / 继续记录 / 暂停记录 间切换：「停止后再开始」本就是续接同一条时间线（`recordingBaseSeconds`），旧文案的「停止」是误导。按钮状态收进 `syncRecordUI`（与 `syncAutoPauseUI` / `syncPdCaptureUI` 同构），录制开关、连接变化、CSV 导入、清空图表统一驱动；合并顺带省下约 56px 横向 min-content
- **PD 采集按钮在「跟随记录」开启时直接控制主监控记录**：此前的「等待记录」态点下去只弹一句解释，现在它就是主记录开关——点击即开始/暂停主监控记录（PD 采集随之启停），外观也换成与监控面板同款的实心强调按钮，视觉上直说「这两个是同一个开关」；未连接设备时禁用。关闭跟随则退回本地的暂停/继续（仅停列表刷新，报文继续进缓冲）。开启跟随时顺手清掉可能残留的本地暂停位，避免留下界面上看不出来的隐藏状态。三态镜像（`syncPdCaptureUI`）由记录开始/停止（含自动暂停、拔设备、CSV 导入）、连接变化、跟随开关、设置加载/重置统一驱动；计数器仍显示「跟随记录等待中」
- **两侧清空在「跟随记录」开启时互相联动**：PD 的「清空」补上与监控「一键重置」同规格的确认弹窗（`ui/dialog.js` 的 `ask`，破坏性操作默认焦点在取消）；跟随开启时清空任意一侧都会同时清掉图表与报文，关闭时各清各的。两侧的确认文案会写明这次会波及哪些数据，两个清空按钮的悬浮提示也随开关切换；跟随记录复选框的提示改为逐条列出三项联动后果。实现上两边各自只调用对方的无级联版本（`clearPdEntries` / `clearAndResetStats`），不会互相递归
- 跨模块广播 `witrn:recording-changed` 更名为 `witrn:monitor-changed`：连接状态变化现在也会广播（PD 采集按钮在跟随模式下要据此启用/禁用），旧名已名不副实
- **图标语义修正**：导入 CSV `cloud-upload`（云端上传）→ `desktop-download`；一键重置与 PD 清空 `trash`（删除）→ `clear-all`；温度服务固定为 `flame`（原为 plug/check 切换，check 挂在"点击即断开"的按钮上误导），连接态由既有高亮表达

### Fixed
- **设置页分段选择点选后的黑框**：主题 / 纵向余量的 radio 点选后 `:focus-within` 会在浅色主题画出 2px 黑描边。改为仅键盘 `:focus-visible` 显示焦点环，鼠标点选不再留框
- **部分按钮顶边的黑线 / 白线**：通用 `.btn` 去掉顶边单独加亮；全局 `button { appearance: none; background-image: none }` 去掉 WebView2 原生高光；实心钮（记录 / 强调 / 危险）边框改跟填充同色，避免透明描边在圆角上抗锯齿出浅顶边
- **休眠 / NTP 不再把能量算爆**：相对时间轴遇到超过 `max(采样间隔 × 8, 2 秒)` 的空档只前进一个采样间隔，后续积分按夹过的 x 走
- **点开始后立刻插充电器不再丢 PD 握手**：先等后端 `set_pd_capture_enabled` 打开再置本地记录标志，并在记录开始时按 seq 补洞
- **不完整的 EPR Source Capabilities 不再覆盖 last_pdo**：只有拼完 PDO 列表的报文才作为后续 Request 的上下文
- **读取身份时重连不再盖掉新连接**：`identify_current_device` 恢复读线程时核对 `connection_epoch`，期间用户另连/断开则放弃恢复
- **PD 导入不再和实时 seq 串台**：日志带 generation，导入/清空期间挂起实时摄入，过期事件直接丢掉
- **Hard Reset / Cable Reset 有 SOP 字节**：按仪表 32 步进编码识别 64 / 32，会话状态会按复位清掉
- **节流窗口保留峰值电流**，避免采样间隔内的尖峰被 last-wins 吃掉；读线程退出时冲掉未发的最后一点
- **电流略超 ±10 A 不再丢整帧**：有效范围放到 ±20 A，明显乱值仍拒绝
- **开始记录时复位选区**到全历史，避免锁定的百分比窗口随点数增长漂走
- **HID 超时不再假装还连着**：曾经读到过报告之后连续 2 秒 `Ok(0)` 视为拔线
- **手动断开也画 PD 分隔行**
- **CSV 导入不再把 SampTime 写进持久化配置**；功率列按绝对值入库，与实时路径一致
- **清空图表后实时卡片不再残留上一轮读数**；导入则以文件最后一点刷新
- **扩展报文 hex 条先拆 Ext Header**，不再把扩展头和前两字节数据糊成一个 32-bit 字
- **Structured VDM Version 2.1** 按规格 bits 14..13 = `10` 识别，不再标成 Reserved
- **PD 导入解析不再握着日志锁**；温度服务 DNS / 5 秒连接也不再占着任务锁
- **PD 日志 100 万条硬顶**，有界同步通道满时丢采样/延后发射，避免内存与队列无界涨
- **拖动界面缩放滑条不再抽搐**：缩放整页会改变滑条自身几何，拖动过程中每一步都 `setZoom` 会让原生 range 按新尺寸重新跟指针，比例来回跳。改为拖动只更新百分比读数，松手（`change`）再应用缩放
- **小窗口下的遮挡与截断**（不分档、所有尺寸受益）：实时侧栏卡片 `flex-shrink: 0`——温度服务连接后温度卡显示、卡片总高超出面板时，原先 flexbox 会先压扁每张卡裁掉数值下沿与 min/max 行（卡片的 `overflow: hidden` 把 flex 最小尺寸归零，900×600 下每卡被裁 16–28px，面板滚动永远不触发），现在恢复正常滚动；浮出面板加 `max-height`（超长时内部滚动，不再伸出视口被裁）；实时侧栏 min/max 读数改省略号截断（原为无省略号硬裁）；时间线导航器 `flex-shrink: 0`（纵向紧张时不再被静默压扁）；设置页字段行允许折行（"外观"行不再溢出 300px 窄卡片边框）；X 轴刻度间距 64→80px，修复 HH:MM:SS.d 标签互相重叠（等宽 12px 下约 10 字符 ≈ 72px，64px 间距在任意宽度都会碰撞）

### Removed
- 状态栏「设备: 型号」一项（与标题栏设备下拉重复）
- Ribbon 时代死代码：旧 `.status-bar` / `.auto-pause-card` / 导出菜单内联实现及其样式、未引用的模板资产（`tauri.svg` / `javascript.svg`）；`index.html` 不再含任何内联 `style=""`（图例/tooltip 生成代码同步改为 CSSOM 赋值，为后续收紧 CSP 铺路）

## [0.1.5] - 2026-08-10

### Fixed
- **Linux 下拉框弹出列表为白底**：WebKitGTK 把 `<select>` 展开后的选项列表交给 GTK 原生控件绘制，CSS 完全作用不到，深色主题下永远是白底。改为自定义下拉组件（`src/dropdown.js`）：原生 `<select>` 保留在 DOM 中作为唯一数据源、仅在视觉上隐藏，另渲染纯 DOM 的按钮与列表，调用方的 `.value` / `.options` / `change` 用法无需改动。option 增删与 `disabled` 变化经 `MutationObserver` 同步；`.value` / `.selectedIndex` 赋值经实例属性拦截同步（属性赋值不反射到 attribute，`MutationObserver` 观察不到）。菜单挂在 `body` 上用 `position: fixed`，避开 ribbon 的 overflow 裁剪与层叠上下文。同时补上 `color-scheme: dark`，让滚动条等其余原生控件也走深色
- **采样率下拉框显示空白**：CSV 导入会把头部 `SampTime(ms)` 的任意值（钳到 10..60000ms）写入下拉框，而列表只有 6 个预设档位；值不在其中时 `selectedIndex` 变成 -1，控件什么都不显示，且该值会被持久化，之后每次启动都是空白。现在按需插入一个表示实际值的选项（10ms → 「100 次/秒」，按间隔升序排列），而不是吸附到最近的预设——`sampleRate` 参与 x 轴换算与能量积分并会下发后端，改动它会让派生量与实际数据对不上
- **未知 PID 的 WITRN 设备无法连接**：设备枚举只匹配硬编码型号表，固件变体不会出现在列表中（C5 已实测到 0x5053 / 0x5064 两个 PID），而界面上的 VID/PID 输入框是只读的，没有手动连接入口，这类设备便完全无法使用。现在按厂商 VID 收全同厂设备，型号不在表内时显示为「未知 WITRN 设备 (VID:PID)」
- **「仅统计选中范围」对累计量失效**：勾选后累计能量（Wh）与容量（mAh）仍显示全量累计值，只有最值/均值跟随选区。现在两者也按选中区间重新积分；积分时间轴取相对秒（`chartSeries.x`）而非挂钟时间戳，与实时累计口径一致，录制暂停留下的空档不会被当作持续放电计入
- **退出流程回环**：确认退出后改为调用后端 `shutdown`（停后台线程 → `destroy` 主窗口）。原先走 `window.close()`，而 Tauri v2 起 `close` 会重新派发 close-requested 事件，与前端的退出确认监听器构成回环；旧代码靠「先注销监听器再 close」规避，但注销是异步 IPC，抢先失败时后端仍返回成功，前端便不再尝试其它路径，窗口就此关不掉。`destroy` 不派发该事件，不存在这个竞争
- **退出时线程 join 死锁**：`shutdown` 标为 `#[tauri::command(async)]`。原 `exit_app` / `close_main_window` 是同步命令，在主线程上 join 后台线程，而后台线程退出前可能仍在 `emit`（需要主线程处理），构成死锁
- **后台任务生命周期**：HID 与温度连接改为每代独立停止标志并保存线程句柄，重连和退出前等待旧线程结束，避免旧连接复活后重复推送数据
- **温度服务稳定性**：读取超时缩短到 250ms，并将空闲超时与真实断线分开处理；低频温度源不再被误判为断开。读超时会带着已读到的半行数据返回，该缓冲保留到下一轮续读，不再被清空成一条残缺数据
- **HID 接口选择**：设备枚举按物理设备分组，有厂商自定义 Usage Page 时优先保留数据接口，并在无法唯一判断时显示接口编号供用户选择
- **录制测量正确性**：开始和停止录制时重置能量积分基线，暂停时长不再被计入 Wh/mAh；导入数据后续录会从最后一个相对时间点连续追加
- **数据完整性**：HID 帧增加长度、帧头以及电压/电流范围校验；温度越界只记为缺失而不丢弃整帧（该字节偏移只在一个型号上验证过，用它否决整帧会让别的固件表现为「连上了但没有数据」）；缺失温度使用 `NaN`，真实的 0°C 可正常进入图表、统计和 CSV 往返
- **CSV 与设置边界**：导入、导出统一从图表列式数据派生；导入采样间隔和持久化设置均做类型及范围校验；Tauri v2 对话框统一使用 `kind` 字段
- **交互可访问性**：导出菜单改为语义化按钮，支持 Enter、Space、Escape、上下方向键和 Home/End；录制期间禁用一键重置
- **前端类型检查**：补回范围时间格式化依赖，修正温度空值与图表窗口状态类型，并隔离父目录 Node 类型污染
- **图表前后空白**：三处根因一并修复——① 移除 X 轴窗口与导航图沿袭旧版的人为留白（0.5% / 最小 0.05s），窗口现在与数据完全齐平；② 范围窗口改为直接取序列 x 坐标（原先用时间戳差值换算，非零时刻起始的 CSV 会在图表前部产生大段空白）；③ 清空图表后 X 轴窗口复位，不再残留旧范围
- **CSV 时间解析**：支持官方软件的 `D.hh:mm:ss.ms` 天数前缀格式（原先 `parseInt("0.01")` 截断导致小时字段丢失、x 每小时回绕非单调，uPlot 依赖有序 x 做二分切片，会表现为图表空白 / 无法显示）；行乱序时自动按时间重排

### Added
- **自动化质量门禁**：新增 Node 纯逻辑/录制状态机测试、Rust HID 帧解析与接口筛选测试，以及覆盖测试、类型检查、lint、格式和 clippy 的 GitHub Actions 工作流
- **可复现工具安装**：提交 `package-lock.json`，本地与 CI 均通过 `npm ci` 安装固定版本的 JavaScript 质量工具
- **Biome 质量门禁**：恢复并锁定 Biome 2.4.4，`npm run lint` 对 warning 级诊断也返回失败，并新增 `npm run format` 安全格式化命令

### Changed
- **移除过度防御**：清理工具软件不需要的冗余保护层
  - 退出流程从 5 级回退链（`close_main_window` → `exit_app` → `destroy` → `close`）收敛为单一确定路径，`app.js` 该段 110 行降到 27 行；顺带删除只为它存在的 `__withTimeout`。其中前端 `appWindow.destroy()` / `close()` 两级本就是死代码——它们属于 `core:window:allow-*` 权限，而本应用只声明了 `core:default`（窗口部分为只读），调用必被 ACL 拒绝
  - `parse_device_data` 移除长度已校验后不可达的 8 处 `?` 分支，并去掉对 `power`（乘积）和 `cc1`/`cc2`（`u8` 换算）这三个不可能非有限的值的判定
  - `enumerate_devices` 移除 `seen_paths` 去重：hidapi 的设备路径本就唯一，该集合不可能命中
  - 删除前端从未调用的 `get_known_devices` 与 `get_temp_service_status` 命令，以及随之不再使用的 `serde_json` 直接依赖
  - `normalizeSettings` / `normalizeAutoPause` 从逐字段类型校验（42 行）收敛为默认值合并 + 仅对参与下标换算和下发后端的字段钳位（22 行）
  - 移除温度端口的重复校验（输入框 change 时已校验，且后端命令签名为 `u16`）、`getVisibleDataRange` 中不可达的负值钳位、温度值的二次有限性判定
  - `typeof state.__setRangeControlsEnabled === 'function'` 三处改用可选调用
- **精简 CI**：移除 `cargo check`——它排在 `cargo clippy --all-targets` 和 `cargo test` 之后，二者均已完整编译
- **项目状态**：撤销 README 归档声明，恢复活跃维护
- **安全权限收紧**：移除未使用的 opener 插件及主目录递归写权限，并为 Tauri WebView 配置基础 CSP
- **流式统计性能**：选中范围统计改为 250ms 节流，避免长录制时每个采样点都执行 O(n) 全量扫描
- **阻塞命令调度**：HID 枚举、设备连接和温度连接交由 Tauri 异步命令调度，避免连接超时冻结界面
- **状态与残留清理**：录制逻辑只依赖 `state.isRecording`，移除旧 TCP 状态、无调用工具函数、调试 Store 探针和未使用 opener 依赖
- **开发文档同步**：README 更新实际显示字段、软件积分语义、uPlot 架构、`measurement.js` 模块与 `test/` 测试结构、HID 校验、安全边界和 CI 使用方法
- **忽略规则整理**：修复 `.vscode/` 与其白名单冲突导致的失效规则、去重 `.idea/`、纠正打包产物与 Python 分类错位、移除无打包器的 `dist/` 残留
- **换行规范**：通过 `.editorconfig`、Biome 和 `.gitattributes` 统一文本文件使用 LF，二进制资源不参与换行转换
- **百万级点数支持**（不做数据降采样）：
  - 自适应路径构建：可见点数 ≤ 1000 时用 spline 平滑，密集视图切换到 uPlot linear 构建器（按像素列聚合 min/max，视觉无损），百万点全景渲染与拖动流畅
  - 关闭 uPlot 每次提交的全量 min/max 扫描（series `auto: false`），Y 轴量程改用已有的增量最大值跟踪
  - 导航图仅在数据变化时重建，拖动范围滑块不再触发其百万点路径重建
  - 范围滑块拖动与范围统计改为 rAF 合并（原先逐事件同步全量重建）
  - 导入不再为每行预生成 recordedData 对象与时间字符串（百万行时节省数秒与数百 MB 内存），导出时按需派生
- **图表引擎迁移**：将 Chart.js 替换为 uPlot（本地 vendor，51KB vs 208KB），完整保留原有图表特性：
  - 四通道曲线与四条独立 Y 轴（左：电压/电流，右：功率/温度），Y 轴随通道显隐自动跟随
  - 悬停 tooltip（index 模式显示全部可见曲线值 + 单位）、顶部图例（仅列出可见曲线）
  - 温度轴整数刻度与电压轴网格对齐、密集细分网格、每通道填充透明度调节
  - 范围滑块 X 轴窗口、导航器缩略图、rAF 节流流式刷新
- **数据结构优化**：图表序列由 `{x, y}` 对象数组改为 uPlot 原生列式数组（内存占用更低，追加零转换开销）；Y 轴量程仍基于全量数据（拖动范围滑块时 Y 轴保持稳定，与旧版行为一致）

## [0.1.4] - 2026-06-03

### Changed
- **代码规范重构**：升级 Biome.js 至 2.4.4，全量优化代码规范及导入排序，修复隐患部分（完善 `parseInt` 进制参数、`try/catch` 流程等）。
- **退出交互优化**：主窗口关闭流程升级，优先尝试调用框架标准的 `window.close()`，提升底层资源释放与多环境下的稳定性。

## [0.1.3] - 2026-03-25

### Changed
- **关闭流程稳定性**：重构应用退出与窗口关闭流程，后端改为原子状态标记并由后台线程自持设备句柄，避免互斥锁争用导致的关闭卡死
- **温度服务线程控制**：温度服务运行状态改为原子变量，连接/断开路径更简洁，状态读取一致性更高
- **曲线填充交互**：移除独立填充开关，改为“透明度 > 0 即启用填充，= 0 即关闭填充”
- **显示通道面板**：将通道显示与填充透明度合并到同一组控件，简化操作路径
- **图表观感优化**：提升主网格与坐标轴文本对比度，温度轴刻度改为整数显示并与电压轴节奏对齐

### Added
- **密集网格插件**：主图新增细分网格绘制（主刻度间补充细分线），提升读图精度与视觉参考性

## [0.1.2] - 2026-02-21

### Changed
- **代码重构**：将单体 `main.js`（2500+ 行）拆分为多个 ES 模块，提升可维护性
  - `app.js` — 应用入口、Tauri API 导入、窗口关闭、UI 事件绑定
  - `state.js` — 共享应用状态与类型定义
  - `chart.js` — Chart.js 初始化、降采样算法、渲染调度
  - `data.js` — 数据采集、统计、录制
  - `device.js` — HID 设备连接管理
  - `csv.js` — CSV 导入/导出
  - `settings.js` — 设置加载/保存
  - `temperature.js` — 温度服务
  - `utils.js` — 通用工具函数
- **UI 布局**：重新组织"统计"工具栏区域布局，添加分隔线与分栏排列

### Added
- **图表降采样**：新增降采样功能，大幅提升大数据量下的图表渲染性能
  - 支持 LTTB（Largest-Triangle-Three-Buckets）降采样算法
  - 支持 MinMax 降采样用于导航器
  - 提供低 / 中 / 高三档降采样强度（5000 / 2000 / 500 点）
  - 可通过工具栏开关启用/关闭
- **开发工具链**：引入 Biome 2.0 作为 linter/formatter，添加 EditorConfig、JSConfig
- **类型标注**：添加 `global.d.ts` 声明 Tauri 全局 API 类型，全面启用 JSDoc 类型检查（`// @ts-check`）

## [0.1.1] - 2026-01-20

### Changed
- **CSV 导入**：适配负数电流数据导入（导入时自动取绝对值）
- **导航图表**：将导航器从显示电压改为显示功率曲线，颜色调整为橙色；修复 Y 轴缩放问题
- **图表范围**：为主图表和导航图表添加边距填充，防止数据点贴边显示
- **字体优化**：引入 Maple Mono NF CN 等宽字体，统一数值显示样式
  - 图表 UI 元素（图例、标题）优先使用系统以中文字体（微软雅黑等）
  - 数值部分保持等宽字体以确保对齐
  - 使用 `font-variant-numeric: tabular-nums` 确保数字等宽对齐
  - 使用本地字体文件 `MapleMono-NF-CN-Regular.ttf`
- **设置保存**：优化设置保存机制
  - 添加防抖保存功能（500ms 延迟），减少频繁写入
  - 加载设置时禁用自动保存，防止覆盖已保存配置
  - 各控件变更时自动触发保存（采样率、图表显示、自动暂停、温度服务等）
  - 关闭超时从 1.2s 增加到 4s，确保设置保存完成
- **Store 初始化**：显式调用 `init()` 确保从磁盘加载配置
- **图表视觉优化**：
  - 统一所有坐标轴开启网格线（10% 透明度）
  - 统一图表刻度显示逻辑：默认保留 3 位小数，针对小数值（<1）自动增加精度（最高 6 位），解决微小电流/电压显示不清的问题
  - 优化曲线填充功能：支持独立控制电压、电流、功率、温度的填充开关和不透明度

### Fixed
- **CSV 导入**：修复在有数据时导入 CSV 未弹出确认提示的问题（防止误清除数据）
- **CSV 导入**：修复导入数据后底部导航图时间轴范围未正确更新的问题
- 修复重置设置时温度 UI 可见性未正确更新的问题
- 修复功率坐标轴刻度显示为科学计数法的问题，改为小数格式
- **图表显示**：将图表中所有数值显示统一调整为默认 3 位小数（包括提示框和坐标轴）
- 修复不透明度输入框文字被 "%" 符号遮挡的问题（隐藏数字调节按钮并优化布局）
- 修复底部导航条缩略图显示不全的问题

### Added
- 添加调试日志输出，便于排查设置加载和保存问题
- **曲线设置**：在工具栏添加高级曲线设置区域
  - 支持独立开启/关闭各通道（V/A/W/T）的曲线填充
  - 支持独立调节填充颜色的不透明度（0-100%）
  - 温度相关设置根据是否有温度连接动态显示/隐藏

## [0.1.0] - 2026-01-20

### Added
- 初始版本发布
- 支持 WITRN USB 功率计（K2、U3、C5 等型号）
- 跨平台桌面应用（基于 Tauri v2）
- HID 通信支持（使用 hidapi）
- 实时数据监控和图表显示
- 设备连接和配置管理
- 数据导出功能
