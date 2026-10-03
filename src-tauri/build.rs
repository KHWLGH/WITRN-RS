use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Mirror of the exclusion in `scripts/build-dist.mjs`: those entries are never copied into `out/`,
/// so touching them must not read as "the frontend changed". Keep the two in sync.
fn shippable(name: &str) -> bool {
    !name.starts_with('.') && !name.ends_with(".d.ts")
}

/// (newest mtime, every shippable file) — one walk serves both the staleness check and the list of
/// paths cargo has to watch.
fn scan(dir: &Path) -> Option<(SystemTime, Vec<PathBuf>)> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<SystemTime> = None;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !shippable(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let path = entry.path();
        if meta.is_dir() {
            if let Some((sub_newest, sub_files)) = scan(&path) {
                if newest.is_none_or(|n| sub_newest > n) {
                    newest = Some(sub_newest);
                }
                files.extend(sub_files);
            }
        } else {
            files.push(path);
            if let Ok(mtime) = meta.modified() {
                if newest.is_none_or(|n| mtime > n) {
                    newest = Some(mtime);
                }
            }
        }
    }
    Some((newest?, files))
}

fn main() {
    // Windows resource compilation must run again when an icon is replaced.
    println!("cargo:rerun-if-changed=icons");
    let src = PathBuf::from("../src");
    let dist = PathBuf::from("../out");

    let src_scan = scan(&src);
    if let Some((_, files)) = &src_scan {
        // Without this, editing a stylesheet re-runs nothing: tauri-build only watches frontendDist,
        // so `generate_context!` would quietly embed the previous build's bytes.
        for path in files {
            println!(
                "cargo:rerun-if-changed={}",
                path.display().to_string().replace('\\', "/")
            );
        }
    }

    match (src_scan.map(|s| s.0), scan(&dist).map(|s| s.0)) {
        (Some(_), None) => panic!(
            "../out 不存在，但它是 tauri.conf.json 里的 frontendDist：generate_context! 会内嵌一个空目录。\n\
             ! 先跑 `npm run build` —— 只有 `cargo tauri dev|build` 会自动跑它，`cargo test|check|clippy` 不会。"
        ),
        (Some(src_newest), Some(dist_newest)) if src_newest > dist_newest => panic!(
            "../out 比 ../src 旧：编译进去的前端是上一版的字节（CSS 合并与 url() 重写都发生在那个构建步骤里）。\n\
             ! 先跑 `npm run build`，再重新编译。"
        ),
        _ => {}
    }

    tauri_build::build()
}
