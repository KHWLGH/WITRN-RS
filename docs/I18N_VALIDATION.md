# Four-language i18n validation

Validated on Windows on 2026-10-08. Browser checks use the existing showcase simulated POWER-Z device and Playwright Chromium; they do not exercise native USB/serial hardware.

| Check | Result |
| --- | --- |
| `npm test` | 338 passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build:dist` | Passed; all translations bundled offline |
| `cargo fmt --check --all` | Passed |
| `cargo check --workspace` | Passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo test --workspace` | 301 passed including doctests; 2 existing performance-report tests ignored |
| [Browser language verification](../tools/showcase/verify-i18n.mjs) | Passed |
| [Documentation verification](../tools/showcase/verify-i18n-docs.mjs) | 16 documents, relative links/anchors and 32 PNG screenshots passed |
| `git diff --check` | Passed |

The locale tests cover script precedence, Chinese regions, Japanese, unsupported and invalid locales, C/POSIX, native/WebView fallback, Linux environment-variable priority, manual override and invalid/old settings. Persistence checks cover reload, reset and storage failures. Dictionaries are checked for keys, interpolation parameters, singular quantities and English fallback.

Browser verification switches English, Simplified Chinese, Traditional Chinese and Japanese with an active connection, recording and PDM session. It checks light/dark at 900×600 and 1280×800, all four workspaces, chart labels/tooltips, custom selects, accessible labels, persistent notifications and open dialogs. Data columns, chart instance, sample count, energy, range, stream generation, PD filter, an actual selected PD message, its decoded details and button/icon/text nodes remain intact. Screenshots were reviewed for long-label layout; PD standard fields and device responses stay in their original form.

CSV and PD capture tests export in each language and import in every other language. They preserve numeric precision, signed current, missing temperature, signal channels, recording segments, mixed sample intervals and compact PD frames. Native file-dialog IPC checks verify translated titles and filter names; OS-provided dialog buttons retain the OS language.

## Documentation alignment

On 2026-10-08, the English, Traditional Chinese and Japanese README, user guide, development guide and temperature-service guide were expanded to match the Simplified Chinese content. They retain the same section hierarchy, tables, lists, commands, technical parameters and file/protocol examples. Language-specific UI labels and links were reviewed; the example Python server's actual Chinese console output is preserved.

`node tools/showcase/verify-i18n-docs.mjs` passed for 16 documents: 12 translations matched section coverage and code examples, 284 relative links/anchors resolved, and all 32 existing language-specific screenshots had valid PNG headers. Biome checks for the verifier and `git diff --check` also passed. This documentation revision did not rerun the application or hardware checks listed above.

## Remaining native acceptance

Actual Linux AppImage startup under different `LANG` / `LC_*` values, macOS GUI/system locale, native file dialogs and physical-meter acquisition require their respective machines and hardware. The Linux priority function is covered by Rust tests, and locale selection is covered by browser tests, but an AppImage was not run on this Windows host.

For AppImage acceptance, clear any saved manual preference by selecting **Follow system**, then start separate application processes:

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=C ./laPower.AppImage
```

Expect English, Japanese, Traditional Chinese and English respectively. Also check a Chinese locale, manual language persistence across restarts, real recording/PDM operation during a switch and native file-dialog titles. Versioning, release packaging/publication and AppImage catalog submission remain in the existing release workflow.
