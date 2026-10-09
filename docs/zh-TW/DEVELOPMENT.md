[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | **繁體中文** | [日本語](../ja/DEVELOPMENT.md)

← 返回 [README](../../README.zh-TW.md)

# 開發與建置

- [環境要求](#環境要求)
- [建置與運行](#建置與運行)
- [發佈流程](#發佈流程)
- [質量檢查](#質量檢查)
- [測試與迴歸邊界](#測試與迴歸邊界)
- [開發展示工具](#開發展示工具)
- [效能測量](#效能測量)
- [CI 門禁](#ci-門禁)
- [Linux 自行編譯](#linux-自行編譯)
- [macOS 自行編譯](#macos-自行編譯)
- [參與貢獻](#參與貢獻)

## 語言選擇

在「設定 → 外觀 → 語言」可選擇跟隨系統、简体中文、繁體中文、English、日本語。切換立即生效並儲存偏好，保留連線、記錄、資料、圖表範圍、篩選和選中報文；重設設定回到自動模式。

Linux 按第一項非空的 LC_ALL → LC_MESSAGES → LANG 檢測；Windows／macOS 使用原生系統 locale。原生不可用時採用 WebView 首選語言，最終回退英文。Hans 優先選擇簡中、Hant 優先選擇繁中；否則 CN／SG 和無區域 zh 為簡中，TW／HK／MO 為繁中，ja 為日文，其餘含 C／POSIX 為英文。統一處理大小寫、下劃線、編碼與修飾後綴；手動選擇覆蓋自動檢測。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 詞典維護與翻譯檢查

src/i18n.js 提供 t(key, params)、locale 解析和語言變更訂閱，四份詞典離線打包，英文作為基準與缺詞回退。src/i18n-messages.js 的四列依次為英文、簡中、繁中、日文。使用語義鍵名，保持插值參數名稱一致；含數量的消息按需補充單數版本。使用者文件以簡中版本為內容基準，其他語言保留相同章節、操作細節、參數和示例；`verify-i18n-docs.mjs` 檢查各節層級、表格與列表、代碼示例、相對鏈接、章節錨點和截圖。

靜態 HTML 使用英文兜底和 data-i18n／data-i18n-title／data-i18n-placeholder／data-i18n-aria-label／data-i18n-alt；含圖示或輸入控制項的元素只標記文字 span。動態內容通過 t 產生，持續通知和日誌用延遲文字函數。切換只更新標籤、選單、下拉和圖表，不能重新連線或重建資料。

應用後端錯誤使用 {code, params, detail?}，異步事件保留原有字段並添加 description；前端翻譯 code，保留原始診斷，仍相容插件字串錯誤。檔案對話框標題與過濾器由前端翻譯，原生按鈕跟隨 OS。PD 標準名、解碼字段、原始回覆、單位和 CSV／PD 資料格式保持相容。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
node tools/showcase/verify-i18n-docs.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

檢查四語、淺深主題、900×600／1280×800、連線和記錄／PDM 狀態、PD 選擇和篩選、CSV／PD 往返、錯誤、檔案入口及無障礙標籤。Linux AppImage 的 LANG／LC_* 實機啟動驗收需在 Linux 完成，瀏覽器模擬不替代原生或硬體驗收。

[本次 i18n 驗證記錄（英文）](../I18N_VALIDATION.md)列出已完成檢查及實機驗收範圍。


## 環境要求

| 組件 | 要求 | 說明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作區 `rust-version` |
| Tauri CLI | 2.12.1 | npm 鎖定的 `@tauri-apps/cli`，通過 `npx --no-install tauri` 調用 |
| Windows | 10 / 11 | 當前開發與驗證平台 |
| macOS | 12+ | 最低部署目標；CI 使用 macOS 26，舊系統相容性需實機驗證 |
| Node.js | 24 | CI、lint / typecheck / test / 前端產物 |

專案使用 npm，提交 `package-lock.json`，CI 使用 `npm ci`。前端是原生 ES Modules，`frontendDist` 指向建置產生的 `out/`；Node 不參與 Rust 編譯，但 `npm run build` 必須先於 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`。改動 `src/` 後先重建 `out/`，再重新鏈接 Rust 二進制。

## 建置與運行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run build
npx --no-install tauri dev
npx --no-install tauri build
```

本機未指定 target 時，發佈產物位於 `target/release/bundle/`；CI 顯式指定 target，產物位於 `target/<target>/release/bundle/`。Tauri CLI 會自動運行 `beforeBuildCommand` 產生壓縮前端，打包前無需再手動執行 `npm run build:dist`。直接運行 Cargo 檢查時仍須先產生 `out/`。

## 發佈流程

開發時統一使用以下命令設定版本號，無需逐個檔案手改：

```bash
npm run version:set -- 0.2.3
```

將 `0.2.3` 換成目標版本即可。命令接受不含前導零的 `X.Y.Z`，先校驗所有檔案，再同步以下位置；重複設定同一版本不會重複寫入，也不會創建 Git 提交或 tag、更新依賴或修改更新日誌：

| 檔案 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 頂層與根包 `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 所有工作區成員包的 `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust 成員 crate 繼續通過 `version.workspace = true` 繼承版本；關於頁從 Tauri 讀取版本，開發展示工具從 `package.json` 讀取版本。更新後重新建置，才能讓可執行檔案和安裝包使用新版本。

`test/version-sync.test.js` 會檢查清單與鎖檔案一致、語義版本格式、workspace 繼承關係、統一更新命令和 macOS private API 設定。正式發佈時整理 `CHANGELOG.md`，將對應的 `Unreleased` 內容歸入新版本。

### 手動建置與首次驗收

將 workflow 提交到預設分支後，在 GitHub 的 **Actions → CI → Run workflow** 選擇要驗證的分支或 Tag。手動觸發會先運行現有質量檢查，再打包四個目標；不會創建或公開 Release，即使選擇的是版本 Tag。

| 目標 | Runner | Rust target | 安裝包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

每個成功目標提供獨立的 `packages-*` 附件，保留 14 天。四目標全部成功後提供 `release-packages`，包含七個安裝包與 `SHA256SUMS`；在解壓目錄中可用 `sha256sum -c SHA256SUMS` 校驗。安裝包名包含版本與平台架構，NSIS EXE 另帶 `_setup`。

首次啟用 Tag 自動發佈前，先手動建置，檢查 Windows 安裝、兩種 Mac 啟動、Linux 安裝及設定 udev 後的裝置連線。macOS 12 相容性需要單獨實機驗證。CI 驗證 Mac 的架構、ad-hoc 簽章、最低系統版本元資料和 DMG 完整性，不運行 GUI 或連線儀表。

macOS 建置顯式使用 `--bundles app,dmg`：Tauri 在僅建置 DMG 時會清理臨時 `.app`，同時指定 APP 才能保留應用供後續校驗。附件收集仍只包含 DMG，不額外發布 APP。

### 推送版本 Tag 自動發佈

完成上述首次驗收後，更新版本、整理更新日誌、運行質量檢查並提交，再推送與清單一致的 Tag，例如：

```bash
git tag v0.2.3
git push origin v0.2.3
```

Tag 必須為 `vX.Y.Z`，且與清單版本一致；不一致會在打包前失敗。CI 使用 Node.js 24、Rust stable、固定的 Tauri CLI 2.12.1 和 `tauri-apps/tauri-action@v1`。npm 通過 `npm ci` 安裝，Cargo 使用 `--locked`；Rust 快取按目標區分並指向工作區根目錄 `target/`。Linux 固定 Ubuntu 22.04，以減少對較新 glibc 的依賴。

只有全部質量檢查與四目標打包成功，才會彙總七個安裝包並產生校驗和。發佈任務使用運行儲存庫的 `GITHUB_TOKEN` 創建臨時草稿，上傳七個包與校驗檔案，再核對遠端附件數量、大小和 SHA-256，最後自動公開正式 Release。無需人工點選 Publish，也不需要另設 PAT；只有發佈任務獲得 `contents: write`，儲存庫的組織策略需允許這項權限。

中文發佈說明由 `scripts/release.mjs` 提取 `CHANGELOG.md` 中與當前版本完全匹配的章節，將分類標題轉為中文，補充三平台安裝說明和校驗和說明。相對文件鏈接自動指向該 Tag 的檔案，不使用 GitHub 自動產生的提交/PR 摘要。版本章節缺失、重複或為空時，發佈在調用 GitHub API 前失敗；草稿重跑時也會更新發布說明。可設定 `GITHUB_REPOSITORY=KHWLGH/laPower` 後運行 `node scripts/release.mjs notes`，在 `dist/release-notes.md` 預覽。

同一 ref 的運行串行處理，不取消正在上傳的發佈。上傳或驗證失敗時 Release 保持草稿；在 Actions 重跑失敗任務即可共用該草稿並替換本次發佈的同名附件。草稿若包含其他附件，須人工檢查後再重跑；同名 Release 已公開時，任務拒絕自動覆蓋。若需修改已發佈的二進制，應更新版本並推送新 Tag。

Windows 當前不做憑證簽章；macOS 使用 ad-hoc 簽章，沒有 Developer ID 簽章和公證；Linux 安裝包不會自動設定 udev 權限。本流程不啟用自動更新，不建置 Windows/Linux ARM64 或 Mac Universal 包。

## 質量檢查

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

`npm test` 使用 Node 內置測試運行器，覆蓋純邏輯、資料處理、協議/檔案契約、安全邊界和版本同步。測試檔案按核心領域組織，當前保留的主要檔案包括：

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace 測試、格式檢查、Clippy 和協議 crate 的 feature 組合檢查繼續保留。涉及 `usbpd-parser` 或 `witrn-hid` 的 feature 門時，按 CI 的組合補跑：

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

## 測試與迴歸邊界

- 普通功能增加、刪除、重命名，UI 佈局、樣式、文案和選項列表變化，預設不新增迴歸測試。
- 只有涉及資料丟失或損壞、協議相容、崩潰或死鎖、安全邊界、發佈建置不變量，或已經確認的高影響歷史缺陷時才增加測試。
- 優先補充現有核心測試，不為每個小功能新建測試檔案、設計方案或 CI job。
- 效能 benchmark 和真機檢查按需手動運行，不作為每次改動的瀏覽器自動迴歸。
- CI 保持固定的核心檢查集合，不因單個功能增加專用迴歸流程。

## 開發展示工具

`tools/showcase/` 是獨立的瀏覽器開發工具，提供虛擬 WITRN K2 與 POWER-Z KM003C、確定性的測量曲線、PD 報文和協議控制結果。資料仍經過軟體現有攝入與渲染邏輯；完整標題列使用 decorum 同款控制項結構與軟體自身的圖示、樣式，視窗行為虛擬化。工具不連線真實儀表，不進入 `src/`、`out/` 或安裝包，也不加入瀏覽器 CI。

首次準備：

```bash
npm ci
npx playwright install chromium
```

交互預覽與產生全部展示圖：

```bash
npm run showcase:dev
npm run showcase:capture
```

預覽預設監聽 `http://127.0.0.1:4173`，預設顯示淺色主題；獨立軟體視圖可用 `/app/?theme=dark` 或 `/app/?theme=system` 指定深色或跟隨系統。軟體標題列可選擇虛擬裝置、連線與中斷連線，記錄按鈕可開始和暫停。開發工具外層提供「填充 120 秒展示資料」「凍結」「繼續模擬」「推進 10 秒」「重設預覽」；填充按鈕自動連線當前選擇的裝置與本機溫度源並開始記錄。協議控制需要選擇 POWER-Z 並連線，然後打開 PDM。連接埠可用 `npm run showcase:dev -- --port 4174` 指定，服務只監聽本機。

截圖命令使用 Chromium、Windows 風格、1280×800 CSS 視口、2 倍像素密度及 100% 介面縮放，產生 2560×1600 PNG。預設使用 POWER-Z、本機溫度源與相同的 120 秒模擬資料，先凍結虛擬時間，再等待實際圖表、報文詳情、字體與控制項渲染完成。輸出為 `docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png`，每種語言各 8 張展示圖（共 32 張）。

可以只截取指定頁面、主題或更改輸出目錄：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` 支持 zh-CN、zh-TW、en、ja（逗號分隔，預設全部）；`--theme` 支持 `light,dark`，預設按淺色、深色順序產生；`--page` 支持 `record,pd,trigger,settings`。輸出目錄相對於儲存庫根目錄，也可使用絕對路徑。修改 `tools/showcase/scenario.js` 可以調整虛擬裝置信息、隨機種子、充電曲線、握手時刻及 PDO / 協議檢測結果。`bridge.js` 實現 Tauri 命令、事件、錄製段、ACK、內存設定與檔案句柄；未實現的調用會明確報錯。CSV / PD 匯出通過瀏覽器下載，CSV 匯入通過瀏覽器檔案選擇器；PD 匯入僅支持包含已固化樣例原始報文的檔案，任意真機報文解碼仍應使用原生軟體。

`pd-fixtures.json` 儲存由現有 `witrn-hid` Rust 解析器產生的原始報文與解碼樹，普通預覽和截圖無需 Rust 編譯。更改 PD 原始樣例後，可在安裝 Rust 的環境中運行 `node tools/showcase/generate-pd.mjs` 重新產生；臨時產生器寫入忽略的 `output/`，編譯產物寫入 `target/`。

瀏覽器上下文使用內存設定與檔案，不讀寫真實應用的資料目錄。軟體使用新的標識 `io.github.khwlgh.lapower`，啟動測量工具也已同步該標識；舊 WITRN-RS 設定不會自動遷移。

## 效能測量

`bench/` 保留算法、存儲、啟動、極值和發貨形狀檢查；瀏覽器 harness、瀏覽器長跑和硬體驗收已移除。

| 命令 | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列存儲、分桶、統計和能量積分基準 |
| `node bench/core.mjs --compare` | 與算法基線比較，結果需結合多輪和主機狀態判斷 |
| `node bench/core.mjs --verify-baseline` | 單次正確性檢查及基線結構校驗，不預熱、不計時 |
| `node bench/phase2.mjs` | 範圍統計和協作切片的前後版本對照 |
| `node bench/phase3.mjs` | 分塊存儲、統計和能量計算的前後版本對照 |
| `node bench/extrema.mjs` | 掃描與極值索引的算法對照 |
| `node bench/startup.mjs` | 原生二進制冷啟動分段，按需手動運行 |
| `node bench/packaging.mjs` | 檢查 `out/` 的發貨檔案和內嵌集合 |
| `cargo bench -p lapower` | Rust 協議解碼、編碼和選擇路徑基準 |

`perf-shape` CI job 只硬性檢查發貨形狀和基線結構；算法和 Rust benchmark 只報告結果，不把單次耗時當作跨主機門禁。

## CI 門禁

`.github/workflows/ci.yml` 在每次 push 和 PR 運行固定的核心檢查：

| Job | 內容 |
| --- | --- |
| `validate` | Linux 依賴、前端建置、JS 測試、typecheck、lint、Rust fmt、Clippy、workspace test |
| `backend-other-platforms` | Windows workspace test；macOS workspace check |
| `crate-features` | 協議 crate 的非預設 feature 組合 Clippy 與 test |
| `perf-shape` | `bench/packaging.mjs`、`core.mjs --verify-baseline`，以及報告型 benchmark |
| `package` | 僅版本 Tag push / 手動觸發；依賴以上四項檢查，四目標並行打包，單個平台失敗不會取消其他目標 |
| `package-summary` | 四目標全部成功後驗證七個安裝包並產生 `SHA256SUMS` |
| `release` | 僅版本 Tag push；上傳並核對附件後自動公開 Release |

普通分支 push 和 PR 只運行原有檢查，不打包或發佈。CI 不運行瀏覽器驗收、硬體長跑或功能表面迴歸。開發展示工具僅用於按需預覽和產生文件圖片，不承擔瀏覽器驗收或 CI 門禁；新增功能不應順手增加專用 workflow、job 或迴歸 harness。發佈指令碼的失敗、重跑、附件完整性和公開版本保護由 `test/release.test.js` 離線驗證。

## Linux 自行編譯

Linux 建置與運行未持續接入真實裝置驗證。Debian / Ubuntu 依賴：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

需要訪問 WITRN HID 時，按發行版設定 `/dev/hidraw*` 的 udev 規則。

### udev 規則（必需）

Debian / Ubuntu 上可創建 `/etc/udev/rules.d/99-lapower.rules`，僅授予當前桌面使用者訪問 WITRN HID 和 POWER-Z USB 介面的權限：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

隨後執行 `sudo udevadm control --reload-rules`，重新插拔裝置，再啟動軟體。`uaccess` 依賴 systemd-logind 的活動本地會話；其他發行版或無桌面會話環境應使用發行版的裝置訪問組規則。POWER-Z 協議控制還需要訪問其 CDC 串口。

## macOS 自行編譯

需要 Xcode Command Line Tools、Rust 穩定版和 npm 鎖定的 Tauri CLI：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API 的 Cargo feature 與 Tauri 設定必須保持一致。平台設定使用 `signingIdentity: "-"` 和 `minimumSystemVersion: "12.0"`；CI 同時設定 `MACOSX_DEPLOYMENT_TARGET=12.0`，保留舊系統部署目標，並通過 `CI=true`、`TAURI_BUNDLER_DMG_IGNORE_CI=false` 跳過 Finder 美化。當前沒有 Developer ID 簽章或 Apple 公證；首次打開方式見 [README 下載與安裝](../../README.zh-TW.md#-下載與安裝)。

普通 macOS CI 做 workspace check；版本 Tag / 手動建置還會產生並驗證 DMG，不運行 GUI 或真機檢查。

## 參與貢獻

1. Fork 儲存庫並創建分支。
2. 完成改動後運行上面的核心質量檢查。
3. 保持前端模塊的 `// @ts-check`，純邏輯優先抽成可直接測試的模塊。
4. 新增裝置型號或韌體前，用實機樣本確認 HID 位元組結構與量程。

測試新增遵循“測試與迴歸邊界”規則；不要為普通 UI 或功能表面變化新增獨立測試、設計文件或 CI job。
