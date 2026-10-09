[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | [繁體中文](../zh-TW/DEVELOPMENT.md) | **日本語**

← [README](../../README.ja.md) に戻る

# 開発とビルド

- [必要な環境](#必要な環境)
- [ビルドと実行](#ビルドと実行)
- [リリース手順](#リリース手順)
- [品質チェック](#品質チェック)
- [テストと回帰確認の範囲](#テストと回帰確認の範囲)
- [開発用プレビュー](#開発用プレビュー)
- [性能測定](#性能測定)
- [CI チェック](#ci-チェック)
- [Linux でのビルド](#linux-でのビルド)
- [macOS でのビルド](#macos-でのビルド)
- [貢献方法](#貢献方法)

## 言語の選択

「設定 → 外観 → 言語」で、システムに従う、简体中文、繁體中文、English、日本語を選択できます。変更は即座に反映・保存され、接続、記録、データ、グラフ範囲、フィルター、選択中のメッセージを保持します。設定をリセットすると自動選択に戻ります。

Linux では LC_ALL → LC_MESSAGES → LANG の順で最初の空でない値を使用し、Windows／macOS ではネイティブのシステム locale を取得します。取得できない場合は WebView の優先言語を使い、最終的に英語へフォールバックします。地域よりも文字体系を優先し、Hans は簡体字、Hant は繁体字を選びます。それ以外では CN／SG と地域なしの zh は簡体字、TW／HK／MO は繁体字、ja は日本語、それ以外（C／POSIX を含む）は英語になります。大文字小文字、アンダースコア、文字コード・修飾子の接尾辞を正規化します。手動選択は自動検出より優先されます。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 辞書の保守と翻訳チェック

`src/i18n.js` は `t(key, params)`、locale 解析、言語変更の購読を提供します。4 辞書をオフラインで同梱し、英語を基準と欠落時のフォールバックに使います。`src/i18n-messages.js` の 4 列は英語、簡体字、繁体字、日本語の順です。意味に基づくキーと共通の補間パラメーター名を使い、件数のあるメッセージには必要に応じて単数形を追加します。利用者向け文書は簡体字版を内容の基準にし、翻訳でも同じ章、操作の詳細、パラメーター、例を保持します。`verify-i18n-docs.mjs` で見出し階層、表・リスト、コード例、相対リンク、アンカー、画像を確認します。

静的 HTML は英語のフォールバックと `data-i18n`／`data-i18n-title`／`data-i18n-placeholder`／`data-i18n-aria-label`／`data-i18n-alt` を使います。アイコンや入力欄を含む要素は文字の span だけを指定します。動的表示は `t`、継続表示する通知・ログは遅延文字列関数を使います。切り替えではラベル・メニュー・選択欄・グラフだけを更新し、再接続やデータの再構築をしません。

アプリのバックエンドエラーは `{code, params, detail?}` を使い、非同期イベントは既存フィールドに `description` を追加します。フロントエンドで code を翻訳し、生の診断情報を保持します。プラグインの文字列エラーにも対応します。ファイルダイアログのタイトル・フィルターは翻訳し、ネイティブボタンは OS に従います。PD 標準名、デコードフィールド、生の応答、単位、CSV／PD のデータ形式は互換性を保持します。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
node tools/showcase/verify-i18n-docs.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

4 言語、両テーマ、900×600／1280×800、接続・記録／PDM 状態、PD 選択・フィルター、CSV／PD 往復、エラー、ファイル選択、アクセシビリティラベルを確認します。Linux AppImage の LANG／LC_* 別起動は Linux 実機で行います。ブラウザーの模擬動作はネイティブ・ハードウェア検証の代わりにはなりません。

[i18n 検証記録（英語）](../I18N_VALIDATION.md)に、実施済みチェックと実機検証の範囲を記載しています。

## 必要な環境

| 項目 | 要件 | 補足 |
| --- | --- | --- |
| Rust | 1.85+ | ワークスペースの `rust-version` |
| Tauri CLI | 2.12.1 | npm で固定した `@tauri-apps/cli` を `npx --no-install tauri` で実行 |
| Windows | 10 / 11 | 現在の開発・検証環境 |
| macOS | 12+ | 最低デプロイ対象。CI は macOS 26、旧 OS 互換性は実機確認が必要 |
| Node.js | 24 | CI、lint／typecheck／test、フロントエンド生成 |

npm を使用し `package-lock.json` を管理し、CI は `npm ci` を使います。フロントエンドは標準 ES Modules で、`frontendDist` は生成した `out/` を参照します。Node は Rust コンパイルには参加しませんが、`cargo build`、`cargo test`、`cargo check`、`cargo clippy` より先に `npm run build` が必要です。`src/` 変更後は `out/` を再生成してから Rust バイナリを再リンクします。

## ビルドと実行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run build
npx --no-install tauri dev
npx --no-install tauri build
```

ローカルで target を指定しなければ配布物は `target/release/bundle/`、CI は明示指定して `target/<target>/release/bundle/` に生成します。Tauri CLI が `beforeBuildCommand` で圧縮済みフロントエンドを生成するため、パッケージ化前の手動 `npm run build:dist` は不要です。Cargo を直接実行する場合は先に `out/` が必要です。

## リリース手順

各ファイルを手で変更せず、共通コマンドでバージョンを設定します。

```bash
npm run version:set -- 0.2.3
```

`0.2.3` を対象バージョンに置き換えます。先頭ゼロのない `X.Y.Z` を受け付け、全ファイル検証後に次の箇所を同期します。同じバージョンを再設定しても再書き込みせず、コミット・タグ作成、依存関係更新、変更履歴編集はしません。

| ファイル | フィールド |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 最上位とルートパッケージの `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 全ワークスペースメンバーの `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust メンバーは `version.workspace = true` で継承します。「このアプリについて」は Tauri、開発用プレビューは `package.json` から取得します。実行ファイルとインストーラーへ反映するには再ビルドします。

`test/version-sync.test.js` はマニフェスト・ロックの整合、セマンティックバージョン、workspace 継承、共通更新コマンド、macOS private API 設定を検証します。正式リリース時は `CHANGELOG.md`（簡体字中国語）の対象 `Unreleased` 項目を新バージョンへ整理します。

### 手動ビルドと初回検証

workflow を既定ブランチへ反映した後、GitHub の **Actions → CI → Run workflow** でブランチ・タグを選びます。既存品質チェックの後に 4 対象をパッケージ化します。バージョンタグを選んでも Release は作成・公開しません。

| 対象 | Runner | Rust target | パッケージ |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

成功した対象ごとに `packages-*` アーティファクトを 14 日間保持します。全対象成功後の `release-packages` は 7 個のインストーラーと `SHA256SUMS` を含み、展開先で `sha256sum -c SHA256SUMS` を実行して確認できます。名前にはバージョン・OS・アーキテクチャ、NSIS EXE には `_setup` も含まれます。

タグ自動公開を初めて使う前に手動ビルドし、Windows インストール、両 Mac の起動、Linux インストールと udev 設定後の接続を確認します。macOS 12 は別途実機検証が必要です。CI は Mac のアーキテクチャ、ad-hoc 署名、最低 OS メタデータ、DMG 完全性を調べますが、GUI・計器接続は実行しません。

macOS は明示的に `--bundles app,dmg` を使います。DMG のみでは Tauri が一時 `.app` を削除するため、APP も指定して後続検証用に残します。配布アーティファクトは DMG のみで、APP は追加公開しません。

### バージョンタグによる自動公開

初回検証後、バージョン・変更履歴を更新し、品質チェックとコミットを済ませ、マニフェストに一致するタグを push します。

```bash
git tag v0.2.3
git push origin v0.2.3
```

タグは `vX.Y.Z` とし、マニフェストと一致しなければパッケージ化前に失敗します。CI は Node.js 24、Rust stable、Tauri CLI 2.12.1、`tauri-apps/tauri-action@v1` を使います。npm は `npm ci`、Cargo は `--locked`、Rust キャッシュは対象別でルート `target/` を参照します。Linux は新しい glibc への依存を抑えるため Ubuntu 22.04 に固定します。

全チェックと 4 対象のビルド成功後、7 個のパッケージを集めてチェックサムを生成します。公開 job は実行リポジトリの `GITHUB_TOKEN` で一時ドラフトを作成し、7 個とチェックサムをアップロードし、リモートの数・サイズ・SHA-256 を照合して自動公開します。手動 Publish や追加 PAT は不要です。この job だけ `contents: write` を持ち、組織ポリシーで許可が必要です。

`scripts/release.mjs` は `CHANGELOG.md` の完全一致するバージョン節から中国語リリースノートを生成し、分類見出しを中国語化し、3 OS のインストール・チェックサム案内を追加します。相対リンクはタグ内のファイルを指し、GitHub の自動コミット・PR 要約は使いません。対象節が欠落・重複・空の場合、GitHub API 呼び出し前に失敗します。ドラフト再実行でも説明を更新します。`GITHUB_REPOSITORY=KHWLGH/laPower` を設定し `node scripts/release.mjs notes` で `dist/release-notes.md` をプレビューできます。

同じ ref の実行は直列化し、アップロード中の公開を中止しません。失敗時はドラフトを保持し、Actions の失敗 job 再実行で再利用・同名添付の置換を行います。別の添付があるドラフトは人が確認してから再実行します。同名 Release が公開済みなら自動上書きを拒否します。公開バイナリの変更には新しいバージョン・タグを使います。

Windows に証明書署名はなく、macOS は Developer ID・公証なしの ad-hoc 署名、Linux は udev を自動設定しません。自動更新、Windows／Linux ARM64、Mac Universal はこの手順の対象外です。

## 品質チェック

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

`npm test` は Node 標準ランナーを使い、純粋ロジック、データ処理、プロトコル・ファイル契約、セキュリティ、バージョン同期を確認します。主要テストは分野ごとに整理しています。

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace テスト、フォーマット、Clippy、プロトコル crate の feature 組み合わせを継続します。`usbpd-parser`／`witrn-hid` の feature 境界を変更したら、CI と同じ組み合わせを追加実行します。

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

## テストと回帰確認の範囲

- 通常の機能追加・削除・名称変更、UI レイアウト・スタイル・文言・選択肢変更では、原則として回帰テストを追加しません。
- データ損失・破損、プロトコル互換、クラッシュ・デッドロック、セキュリティ、リリースビルドの不変条件、確認済みの重大な過去の不具合に限って追加します。
- 既存の主要テストを優先し、小機能ごとにテストファイル・設計資料・CI job を作りません。
- ベンチマークと実機確認は必要時に手動で行い、毎回のブラウザー自動回帰にはしません。
- CI の主要チェック集合を固定し、機能ごとの専用回帰 workflow を増やしません。

## 開発用プレビュー

`tools/showcase/` は独立したブラウザー開発ツールです。仮想 WITRN K2／POWER-Z KM003C、決定的な測定曲線、PD メッセージ、制御結果を提供し、アプリの既存取り込み・描画処理を通します。タイトルバーは decorum と同じ構造の操作部とアプリ自身のアイコン・スタイルを使い、ウィンドウ動作を模擬します。実機には接続せず、`src/`、`out/`、インストーラーに含めず、ブラウザー CI に追加しません。

初回準備：

```bash
npm ci
npx playwright install chromium
```

対話プレビューと全画像の生成：

```bash
npm run showcase:dev
npm run showcase:capture
```

既定の URL は `http://127.0.0.1:4173`、テーマはライトです。独立アプリ表示では `/app/?theme=dark`／`/app/?theme=system` を指定できます。タイトルバーで仮想デバイスの選択・接続・切断、記録ボタンで開始・停止を操作できます。外側の開発ツールには 120 秒のデータ投入、凍結、シミュレーション再開、10 秒進める、リセットがあります。データ投入は選択計器とデバイス温度を接続して記録を始めます。プロトコル制御は POWER-Z 接続後に PDM を開きます。ポートは `npm run showcase:dev -- --port 4174` で変更でき、ローカルのみ待ち受けます。

キャプチャは Chromium、Windows スタイル、1280×800 CSS ビューポート、2 倍ピクセル密度、100% UI 倍率を使い、2560×1600 PNG を作成します。既定で POWER-Z、デバイス温度、共通の 120 秒データを使い、仮想時間を止めてからグラフ・詳細・フォント・操作部の描画完了を待ちます。`docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png` に言語ごと 8 枚、合計 32 枚を出力します。

ページ・テーマ・出力先を限定する場合：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` は zh-CN、zh-TW、en、ja（カンマ区切り、既定は全部）、`--theme` は `light,dark`（既定でこの順）、`--page` は `record,pd,trigger,settings` に対応します。出力先はリポジトリルートからの相対パス、または絶対パスです。`tools/showcase/scenario.js` でデバイス情報、乱数シード、充電曲線、ハンドシェイク時刻、PDO・検出結果を変更できます。`bridge.js` は Tauri コマンド・イベント、記録区間、ACK、メモリー設定、ファイルハンドルを実装し、未実装呼び出しは明示的に失敗します。CSV／PD はブラウザーダウンロードで保存し、CSV はファイル選択で読み込みます。PD は固定サンプルの生メッセージを含むファイルのみ読み込め、任意の実機デコードにはネイティブアプリを使います。

`pd-fixtures.json` は既存 `witrn-hid` Rust パーサーで生成した生データとデコードツリーです。通常のプレビュー・撮影では Rust ビルドは不要です。生サンプルを変えたら Rust 環境で `node tools/showcase/generate-pd.mjs` を実行します。一時ジェネレーターは無視対象の `output/`、コンパイル結果は `target/` に置きます。

ブラウザーはメモリー設定・ファイルを使い、実アプリのデータ領域を読み書きしません。新識別子 `io.github.khwlgh.lapower` は起動測定ツールにも反映されています。旧 WITRN-RS 設定は自動移行しません。

## 性能測定

`bench/` はアルゴリズム、ストレージ、起動、極値、配布構成のチェックを保持します。ブラウザー harness・長時間実行・実機検証はここから削除しています。

| コマンド | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列形式ストレージ、バケット、統計、電力量積分 |
| `node bench/core.mjs --compare` | ベースライン比較。複数回の結果とホスト状態を考慮 |
| `node bench/core.mjs --verify-baseline` | 正しさと基準構造の単回確認。ウォームアップ・計時なし |
| `node bench/phase2.mjs` | 範囲統計と協調分割の変更前後比較 |
| `node bench/phase3.mjs` | 分割ストレージ、統計、電力量計算の変更前後比較 |
| `node bench/extrema.mjs` | スキャンと極値インデックスの比較 |
| `node bench/startup.mjs` | ネイティブコールドスタートの各段階。必要時に手動 |
| `node bench/packaging.mjs` | `out/` の配布ファイルと埋め込み集合 |
| `cargo bench -p lapower` | Rust のデコード、エンコード、選択処理 |

`perf-shape` CI は配布構成と基準構造だけを必須判定にします。アルゴリズム・Rust ベンチマークは結果を報告し、単回の時間をホスト間の合否条件にはしません。

## CI チェック

`.github/workflows/ci.yml` は push／PR ごとに固定の主要チェックを実行します。

| Job | 内容 |
| --- | --- |
| `validate` | Linux 依存関係、フロントエンドビルド、JS テスト、typecheck、lint、Rust fmt、Clippy、workspace test |
| `backend-other-platforms` | Windows workspace test、macOS workspace check |
| `crate-features` | 非既定 feature 組み合わせの Clippy・test |
| `perf-shape` | `bench/packaging.mjs`、`core.mjs --verify-baseline`、報告型 benchmark |
| `package` | バージョンタグ push／手動のみ。先の 4 チェックに依存し、4 対象を並列化、1 対象の失敗で他を中止しません |
| `package-summary` | 全対象成功後、7 パッケージを検証し `SHA256SUMS` を生成 |
| `release` | バージョンタグ push のみ。添付をアップロード・照合して自動公開 |

通常ブランチ push／PR はチェックのみで、パッケージ化・公開はしません。CI はブラウザー検証、実機長時間テスト、機能表面の回帰を実行しません。開発プレビューは必要時の確認と文書画像生成用であり、ブラウザー検証・CI の合否判定は担いません。新機能に専用 workflow、job、harness を付け足さないでください。公開スクリプトの失敗・再実行・添付完全性・公開済み保護は `test/release.test.js` がオフライン検証します。

## Linux でのビルド

Linux のビルド・実行は継続的な実機検証に接続していません。Debian／Ubuntu の依存関係：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

WITRN HID にはディストリビューションに応じた `/dev/hidraw*` の udev ルールが必要です。

### udev ルール（必須）

Debian／Ubuntu では `/etc/udev/rules.d/99-lapower.rules` を作成し、現在のデスクトップユーザーに WITRN HID と POWER-Z のアクセスを許可できます。

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

`sudo udevadm control --reload-rules` を実行し、計器を挿し直して起動します。`uaccess` は systemd-logind のアクティブなローカルセッションに依存します。他ディストリビューションやデスクトップなし環境では、その環境のデバイスアクセス用グループルールを使用してください。POWER-Z 制御は CDC シリアルポートへのアクセスも必要です。

## macOS でのビルド

Xcode Command Line Tools、Rust stable、npm で固定した Tauri CLI が必要です。

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API の Cargo feature と Tauri 設定を一致させます。プラットフォーム設定は `signingIdentity: "-"`、`minimumSystemVersion: "12.0"`、CI は `MACOSX_DEPLOYMENT_TARGET=12.0` で旧 OS 対象を保持し、`CI=true`、`TAURI_BUNDLER_DMG_IGNORE_CI=false` で Finder 装飾を省略します。Developer ID・Apple 公証はありません。初回起動は [README のインストール](../../README.ja.md#-ダウンロードとインストール)を参照してください。

通常 macOS CI は workspace check、タグ・手動ビルドは DMG 生成・検証も行います。GUI・実機テストは実行しません。

## 貢献方法

1. Fork してブランチを作成します。
2. 変更後に上記の主要品質チェックを実行します。
3. フロントエンドの `// @ts-check` を保ち、純粋ロジックは直接テストできるモジュールへ分離します。
4. モデル・ファームウェア追加前に、実機サンプルで HID バイト構造と測定範囲を確認します。

テスト追加は「テストと回帰確認の範囲」に従い、通常の UI・機能表面変更のために独立テスト・設計資料・CI job を追加しません。
