**English** | [简体中文](../DEVELOPMENT.md) | [繁體中文](../zh-TW/DEVELOPMENT.md) | [日本語](../ja/DEVELOPMENT.md)

← Back to [README](../../README.md)

# Development and build

- [Requirements](#requirements)
- [Build and run](#build-and-run)
- [Release process](#release-process)
- [Quality checks](#quality-checks)
- [Testing and regression boundaries](#testing-and-regression-boundaries)
- [Development showcase](#development-showcase)
- [Performance measurements](#performance-measurements)
- [CI gates](#ci-gates)
- [Building on Linux](#building-on-linux)
- [Building on macOS](#building-on-macos)
- [Contributing](#contributing)

## Language selection

In **Settings → Appearance → Language**, choose Follow system, 简体中文, 繁體中文, English or 日本語. Changes take effect immediately and are saved, preserving the connection, recording, data, chart range, filters and selected message. Resetting settings restores automatic selection.

Linux uses the first non-empty variable in LC_ALL → LC_MESSAGES → LANG order; Windows/macOS use the native system locale. If native detection is unavailable, the WebView preferred language is used, with English as the final fallback. Hans selects Simplified Chinese and Hant Traditional Chinese before considering regions; otherwise CN/SG and bare zh select Simplified Chinese, TW/HK/MO Traditional Chinese, and ja Japanese. All other locales, including C/POSIX, select English. Case, underscores, encoding and modifier suffixes are normalized. Manual selection overrides detection.

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## Dictionary maintenance and translation checks

`src/i18n.js` provides `t(key, params)`, locale resolution and language-change subscriptions. Four dictionaries ship offline, with English as the reference and missing-key fallback. The four columns in `src/i18n-messages.js` are English, Simplified Chinese, Traditional Chinese and Japanese. Use semantic keys, keep interpolation parameter names consistent, and add singular forms for count messages where needed. User documentation uses the Simplified Chinese version as its content reference; translations are reviewed manually.

Static HTML uses English fallback text and `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria-label` / `data-i18n-alt`. For elements containing icons or inputs, mark only the text span. Generate dynamic content with `t`, using deferred text functions for persistent notifications and logs. Switching languages refreshes labels, menus, dropdowns and charts without reconnecting or rebuilding data.

Backend application errors use `{code, params, detail?}`; asynchronous events retain existing fields and add `description`. The frontend translates codes, keeps raw diagnostics and accepts plugin string errors. File-dialog titles and filters are translated by the frontend; native buttons follow the OS. PD standard names, decoded fields, raw replies, units and CSV/PD data formats remain compatible.

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

Check all four languages, both themes, 900×600/1280×800, connection and recording/PDM states, PD selection and filters, CSV/PD round trips, errors, file-dialog entry points and accessibility labels. AppImage startup with Linux LANG/LC_* must be checked on Linux; browser simulation does not replace native or hardware acceptance.

[The i18n validation record](../I18N_VALIDATION.md) lists completed checks and the real-machine acceptance scope.

## Requirements

| Component | Requirement | Notes |
| --- | --- | --- |
| Rust | 1.85+ | Workspace `rust-version` |
| Tauri CLI | 2.12.1 | npm-locked `@tauri-apps/cli`, invoked with `npx --no-install tauri` |
| Windows | 10 / 11 | Current development and verification platform |
| macOS | 12+ | Minimum deployment target; CI uses macOS 26; older-system compatibility needs hardware verification |
| Node.js | 24 | CI, lint/typecheck/test and frontend output |

The project uses npm and commits `package-lock.json`; CI uses `npm ci`. The frontend is plain ES Modules and `frontendDist` points to generated `out/`. Node is not part of Rust compilation, but `npm run build` must precede `cargo build`, `cargo test`, `cargo check` and `cargo clippy`. After changing `src/`, rebuild `out/` before relinking the Rust binary.

## Build and run

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run build
npx --no-install tauri dev
npx --no-install tauri build
```

Without an explicit target, local release output is in `target/release/bundle/`; CI specifies targets and uses `target/<target>/release/bundle/`. Tauri CLI runs `beforeBuildCommand` automatically to generate the minified frontend, so a separate `npm run build:dist` is unnecessary before packaging. Direct Cargo checks still require `out/` first.

## Release process

Use the shared version command instead of editing individual files:

```bash
npm run version:set -- 0.2.3
```

Replace `0.2.3` with the target version. The command accepts `X.Y.Z` without leading zeros, validates all files before writing, and synchronizes these locations. Repeating the same version does not rewrite files, create commits/tags, update dependencies or edit the changelog:

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | Top-level and root package `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | Every workspace member package's `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust member crates inherit through `version.workspace = true`. About reads the version from Tauri; the showcase reads `package.json`. Rebuild after changing it so executables and installers use the new version.

`test/version-sync.test.js` checks manifest/lock consistency, semantic versions, workspace inheritance, the shared update command and macOS private API configuration. For a release, organize `CHANGELOG.md` (Simplified Chinese) by moving the relevant `Unreleased` entries under the new version.

### Manual builds and initial acceptance

Once the workflow is on the default branch, select the branch/tag in GitHub **Actions → CI → Run workflow**. Manual runs perform the existing quality checks and package four targets. They do not create or publish a Release, even when a version tag is selected.

| Platform | Runner | Rust target | Installers |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI, NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB, RPM, AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

Each successful target provides a separate `packages-*` artifact retained for 14 days. If all four succeed, `release-packages` contains seven installers and `SHA256SUMS`. Run `sha256sum -c SHA256SUMS` in the extracted directory. Package names include version and platform architecture; NSIS EXE also uses `_setup`.

Before enabling automatic tag releases, manually build and verify Windows installation, launch on both Mac architectures, Linux installation and device connection after udev setup. Check macOS 12 compatibility separately on hardware. CI verifies Mac architecture, ad-hoc signatures, minimum-system metadata and DMG integrity; it does not run the GUI or connect meters.

macOS explicitly uses `--bundles app,dmg`. Tauri removes the temporary `.app` when building only a DMG; specifying APP also retains it for subsequent validation. Artifact collection still publishes only DMG.

### Automatic release on a version tag

After initial acceptance, update the version, organize the changelog, run checks, commit and push a tag matching the manifests, for example:

```bash
git tag v0.2.3
git push origin v0.2.3
```

Tags must be `vX.Y.Z` and match manifest versions, or packaging fails before it starts. CI uses Node.js 24, Rust stable, Tauri CLI 2.12.1 and `tauri-apps/tauri-action@v1`. npm uses `npm ci`, Cargo uses `--locked`, and per-target Rust caches point to the workspace root `target/`. Linux stays on Ubuntu 22.04 to limit dependence on newer glibc.

Only after all quality checks and four builds succeed does CI collect seven installers and generate checksums. The release job uses the running repository's `GITHUB_TOKEN` to create a temporary draft, upload packages/checksums, verify remote asset count, sizes and SHA-256, then publish the Release automatically. No manual Publish or additional PAT is needed. Only this job receives `contents: write`; organizational policy must permit it.

`scripts/release.mjs` generates Chinese release notes from the exact matching version section of `CHANGELOG.md`, translating category headings to Chinese and adding installation/checksum instructions for all three platforms. Relative documentation links point to the tag's files; GitHub-generated commit/PR summaries are not used. Missing, duplicate or empty version sections fail before GitHub API calls. Draft retries also update notes. Set `GITHUB_REPOSITORY=KHWLGH/laPower` and run `node scripts/release.mjs notes` to preview `dist/release-notes.md`.

Runs for the same ref are serialized without canceling an active upload. Upload/verification failure leaves a draft; rerun failed Actions jobs to reuse it and replace this release's same-name assets. If the draft contains other assets, inspect it before retrying. Already public Releases are never overwritten automatically. Changes to published binaries require a new version and tag.

Windows currently lacks certificate signing; macOS uses ad-hoc signatures without Developer ID/notarization; Linux packages do not configure udev. This process does not enable an updater or build Windows/Linux ARM64 or Mac Universal packages.

## Quality checks

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

`npm test` uses Node's built-in runner for pure logic, data processing, protocol/file contracts, security boundaries and version synchronization. Tests are organized by core domain; major retained files include:

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace tests, formatting, Clippy and protocol-crate feature combinations remain in place. When changing `usbpd-parser` or `witrn-hid` feature gates, run the CI combinations:

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

## Testing and regression boundaries

- Ordinary feature additions/removals/renames, UI layout, style, wording and option-list changes do not require new regression tests by default.
- Add tests for data loss/corruption, protocol compatibility, crashes/deadlocks, security boundaries, release-build invariants or confirmed historical defects with high impact.
- Extend existing core tests first; do not create a test file, design document or CI job for every small feature.
- Run performance benchmarks and real-device checks manually as needed, rather than browser regression on every change.
- Keep CI's core checks fixed; individual features should not add dedicated regression workflows.

## Development showcase

`tools/showcase/` is a separate browser development tool with virtual WITRN K2 and POWER-Z KM003C devices, deterministic measurements, PD messages and protocol-control results. Data uses the app's existing ingestion/rendering logic. The full title bar uses decorum-style control structure and the app's icons/styles with virtual window behavior. It does not connect hardware, enter `src/`, `out/` or installers, or join browser CI.

Initial setup:

```bash
npm ci
npx playwright install chromium
```

Interactive preview and all showcase images:

```bash
npm run showcase:dev
npm run showcase:capture
```

The preview listens on `http://127.0.0.1:4173` and defaults to light mode. Standalone app views accept `/app/?theme=dark` or `/app/?theme=system`. The title bar selects/connects/disconnects virtual devices, and recording controls start/pause. The outer development tool offers filling 120 seconds of data, freezing, resuming simulation, advancing 10 seconds and resetting the preview. Filling automatically connects the selected meter and device temperature source and starts recording. Protocol control requires connecting POWER-Z and opening PDM. Use `npm run showcase:dev -- --port 4174` to change the port; the server listens only locally.

Capture uses Chromium, Windows window style, a 1280×800 CSS viewport, 2× pixel density and 100% UI scale, producing 2560×1600 PNGs. Defaults use POWER-Z, device temperature and the same 120 seconds of simulated data. Virtual time is frozen before waiting for actual charts, details, fonts and controls to finish rendering. Output is `docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png`, eight images per language and 32 total.

The About version comes from package.json; capture checks the version, language and viewport overflow. Images are written only to language subdirectories, without duplicate copies in the screenshot root.

Capture selected pages/themes or choose another output directory:

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` accepts zh-CN, zh-TW, en, ja (comma-separated; all by default). `--theme` accepts `light,dark`, generated in that order by default. `--page` accepts `record,pd,trigger,settings`. Output directories are relative to the repository root or absolute. Edit `tools/showcase/scenario.js` to change virtual device information, random seed, charging curves, handshake timing and PDO/protocol-detection results. `bridge.js` implements Tauri commands, events, recording segments, ACKs, in-memory settings and file handles; unimplemented calls fail explicitly. CSV/PD export uses browser downloads; CSV import uses a browser file picker. PD import supports only raw messages included in the frozen fixtures; arbitrary hardware messages still need the native app for decoding.

`pd-fixtures.json` stores raw messages and trees generated by the existing `witrn-hid` Rust parser. Normal preview/capture needs no Rust compilation. After changing raw fixtures, regenerate with `node tools/showcase/generate-pd.mjs` in a Rust environment. The temporary generator goes in ignored `output/`, and build artifacts in `target/`.

Browser settings and files are in memory and do not access real app data directories. The app uses `io.github.khwlgh.lapower`, also reflected in startup measurement tools. Former WITRN-RS settings are not migrated automatically.

## Performance measurements

`bench/` retains algorithm, storage, startup, extrema and shipping-shape checks. Browser harnesses, long browser runs and hardware acceptance have been removed from it.

| Command | Purpose |
| --- | --- |
| `node bench/core.mjs` | Column storage, buckets, statistics and energy integration |
| `node bench/core.mjs --compare` | Algorithm baseline comparison; interpret across repeated runs and host conditions |
| `node bench/core.mjs --verify-baseline` | One correctness/structure check, without warmup or timing |
| `node bench/phase2.mjs` | Before/after range statistics and cooperative slicing |
| `node bench/phase3.mjs` | Before/after chunked storage, statistics and energy |
| `node bench/extrema.mjs` | Scan versus extrema-index algorithms |
| `node bench/startup.mjs` | Native cold-start phases, manual as needed |
| `node bench/packaging.mjs` | Shipping files and embedded set in `out/` |
| `cargo bench -p lapower` | Rust protocol decoding, encoding and selection paths |

The `perf-shape` CI job enforces only shipping shape and baseline structure. Algorithm/Rust benchmarks report results rather than using single-run timing as a cross-host gate.

## CI gates

`.github/workflows/ci.yml` runs the fixed core checks on every push and PR:

| Job | Contents |
| --- | --- |
| `validate` | Linux dependencies, frontend build, JS tests, typecheck, lint, Rust fmt, Clippy and workspace tests |
| `backend-other-platforms` | Windows workspace tests; macOS workspace check |
| `crate-features` | Clippy/tests for non-default protocol-crate feature combinations |
| `perf-shape` | `bench/packaging.mjs`, `core.mjs --verify-baseline` and reporting benchmarks |
| `package` | Version-tag pushes/manual runs only; depends on the four checks above, packages four targets in parallel without canceling others on one failure |
| `package-summary` | Verifies seven installers and generates `SHA256SUMS` after all targets succeed |
| `release` | Version-tag pushes only; uploads/verifies assets and publishes automatically |

Ordinary branch pushes and PRs run checks without packaging or release. CI does not run browser acceptance, hardware endurance or surface-feature regressions. The showcase is for optional preview/documentation images, not browser acceptance or a CI gate. New features should not add a workflow/job/regression harness incidentally. `test/release.test.js` verifies failure, retries, asset integrity and public-release protection offline.

## Building on Linux

Linux builds/runtime are not continuously verified with hardware. Debian/Ubuntu dependencies:

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

For WITRN HID, configure the distribution's udev rules for `/dev/hidraw*`.

### udev rules (required)

On Debian/Ubuntu, create `/etc/udev/rules.d/99-lapower.rules` to grant the active desktop user access to WITRN HID and POWER-Z interfaces:

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

Run `sudo udevadm control --reload-rules`, unplug/reconnect the meter, then start the app. `uaccess` depends on an active local systemd-logind session. Other distributions/headless environments should use their device-access group rules. POWER-Z protocol control also requires its CDC serial port.

## Building on macOS

Install Xcode Command Line Tools, Rust stable and the npm-locked Tauri CLI:

```bash
npm ci
npm run build
npx --no-install tauri build
```

The macOS private API Cargo feature and Tauri configuration must match. Platform configuration uses `signingIdentity: "-"` and `minimumSystemVersion: "12.0"`. CI sets `MACOSX_DEPLOYMENT_TARGET=12.0` to preserve the deployment target, plus `CI=true` and `TAURI_BUNDLER_DMG_IGNORE_CI=false` to skip Finder styling. There is no Developer ID signature or Apple notarization. See [README installation](../../README.md#-download-and-installation) for first launch.

Ordinary macOS CI performs workspace check; version-tag/manual builds also generate and verify DMGs, without GUI or hardware checks.

## Contributing

1. Fork the repository and create a branch.
2. Run the core quality checks after completing changes.
3. Keep frontend `// @ts-check`; extract pure logic into directly testable modules where practical.
4. Verify HID byte layouts and ranges with hardware samples before adding a model or firmware.

Follow the testing boundaries above; ordinary UI/surface-feature changes should not add standalone tests, design documents or CI jobs.
