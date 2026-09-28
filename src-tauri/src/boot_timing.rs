//! Cold-start / first-frame instrumentation.
//!
//! t0 is the first statement of `main()`, captured in a `OnceLock`, and bridged to the webview
//! through `performance.timeOrigin` — which is epoch-based, so `timeOrigin − t0_epoch_ms` covers
//! the whole cargo→embed-unpack→webview-create→navigation span without the page needing Rust's
//! monotonic clock. Wall-clock-since-launch is deliberately NOT the anchor: installer and
//! Defender first-scan noise dominates it, so it cannot be gated on.
//!
//! The report is also written to a file because release builds set `windows_subsystem = "windows"`
//! and therefore have no stderr to read. That write is gated behind `debug_assertions`: a shipped
//! build still does the bookkeeping (a few map inserts) but never touches the disk.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Display order in the written file; anything not listed sorts after these.
const STAGE_ORDER: &[&str] = &[
    "process_start",
    "run_enter",
    "plugins_registered",
    "setup_enter",
    "titlebar_created",
    "setup_exit",
    "web_reported",
    "reported",
];

struct Start {
    instant: Instant,
    epoch_ms: u64,
}

impl Default for Start {
    /// Used only if something stamps a stage before `record_process_start` runs.
    fn default() -> Self {
        Start {
            instant: Instant::now(),
            epoch_ms: system_epoch_ms(),
        }
    }
}

static START: OnceLock<Start> = OnceLock::new();
static STAGES: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
static WEB: OnceLock<Mutex<Option<WebTiming>>> = OnceLock::new();

fn system_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// Record the process start in both clocks. Call as the very first statement of `main()`.
pub fn record_process_start() {
    START.get_or_init(|| Start {
        instant: Instant::now(),
        epoch_ms: system_epoch_ms(),
    });
    mark("process_start");
}

fn start() -> &'static Start {
    START.get_or_init(Start::default)
}

fn elapsed_ms() -> u64 {
    start().instant.elapsed().as_millis() as u64
}

/// Stamp elapsed-ms against a named stage. Re-stamping wins, so a stage may be closed under the
/// same name it was opened with when only the total matters.
pub fn mark(stage: &str) {
    let stages = STAGES.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Ok(mut map) = stages.lock() {
        map.insert(stage.to_string(), elapsed_ms());
    }
}

#[derive(serde::Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSummary {
    pub count: usize,
    pub first_start_ms: f64,
    pub last_end_ms: f64,
    /// Wall span the sub-resource phase occupied, not a sum of durations.
    pub total_ms: f64,
    /// Requests grouped by host. `count` alone cannot answer "did this frontend shape fetch less?",
    /// because Tauri's own IPC calls sit in the same resource list.
    pub by_host: std::collections::BTreeMap<String, usize>,
}

/// What the page measured, in its own clock domain.
#[derive(serde::Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebTiming {
    /// `performance.timeOrigin`, epoch ms with sub-millisecond resolution.
    pub time_origin_ms: f64,
    pub first_paint_ms: Option<f64>,
    pub first_contentful_paint_ms: Option<f64>,
    /// Page-side marks, ms after the page's own timeOrigin.
    #[serde(default)]
    pub marks: BTreeMap<String, f64>,
    /// Sub-resource fetches, which is the cost a CSS/HTML merge would remove.
    pub resources: Option<ResourceSummary>,
    pub user_agent: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// ms from process start until the webview context existed — the part the page cannot see.
    /// Null until the page has reported.
    context_ms: Option<u64>,
    stages_ms: BTreeMap<String, u64>,
    web: Option<WebTiming>,
    debug_build: bool,
}

fn build_report() -> Report {
    let web = WEB
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let context_ms = web.as_ref().and_then(|w| {
        let delta = w.time_origin_ms - start().epoch_ms as f64;
        (delta.is_finite() && (0.0..1e12).contains(&delta)).then_some(delta as u64)
    });
    let raw = STAGES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let stages_ms = STAGE_ORDER
        .iter()
        .filter_map(|key| raw.get(*key).map(|ms| ((*key).to_string(), *ms)))
        .chain(
            raw.iter()
                .filter(|(key, _)| !STAGE_ORDER.contains(&key.as_str()))
                .map(|(key, ms)| (key.clone(), *ms)),
        )
        .collect();
    Report {
        context_ms,
        stages_ms,
        web,
        debug_build: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn get_boot_timing(app: AppHandle) -> Report {
    write_if_debug(&app);
    build_report()
}

/// Sent by the page once its paint entries exist. May be sent again for later marks.
#[tauri::command]
pub fn report_boot_timing(app: AppHandle, timing: WebTiming) -> Report {
    set_web(timing);
    mark("web_reported");
    write_if_debug(&app);
    build_report()
}

fn set_web(timing: WebTiming) {
    *WEB.get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(timing);
}

fn write_if_debug(app: &AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(&build_report()) {
        let _ = fs::write(dir.join("boot-timing.json"), json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These share process-wide statics, so each test asserts only about what it itself wrote.
    #[test]
    fn a_stage_stamp_reaches_the_report_in_process_time() {
        record_process_start();
        let stage = "test_stage_a";
        mark(stage);
        let report = build_report();
        let ms = *report
            .stages_ms
            .get(stage)
            .expect("stage should be reported");
        assert!(report.stages_ms.contains_key("process_start"));
        assert!(
            ms < 60_000,
            "process time should still be small in a test binary, got {ms}ms"
        );
        assert!(
            report.debug_build,
            "test builds are debug builds; the file write depends on this"
        );
    }

    #[test]
    fn context_ms_bridges_the_two_clocks() {
        let expected = system_epoch_ms() as f64 + 250.0;
        set_web(WebTiming {
            time_origin_ms: expected,
            first_paint_ms: Some(12.0),
            first_contentful_paint_ms: Some(30.0),
            marks: BTreeMap::new(),
            resources: None,
            user_agent: "test".into(),
        });
        let context = build_report().context_ms.expect("a bridge");
        assert!(
            (200..1000).contains(&context),
            "expected ~250ms, got {context}ms"
        );
    }

    #[test]
    fn a_timeorigin_before_process_start_reports_nothing_instead_of_a_lie() {
        set_web(WebTiming {
            time_origin_ms: start().epoch_ms as f64 - 5_000.0,
            first_paint_ms: None,
            first_contentful_paint_ms: None,
            marks: BTreeMap::new(),
            resources: None,
            user_agent: String::new(),
        });
        assert_eq!(build_report().context_ms, None);
    }

    #[test]
    fn the_pages_resource_breakdown_survives_the_ipc_boundary() {
        // Key names are the risk: the page sends camelCase `byHost`, and a mismatch here deserializes
        // into an empty map with no error at all -- which would silently delete the only field that
        // can answer "did the merged frontend fetch fewer assets?", since raw `count` also counts the
        // app's own IPC calls.
        let timing: WebTiming = serde_json::from_value(serde_json::json!({
            "timeOriginMs": 1.0,
            "firstPaintMs": null,
            "firstContentfulPaintMs": null,
            "marks": {},
            "userAgent": "test",
            "resources": {
                "count": 3, "firstStartMs": 1.0, "lastEndMs": 2.0, "totalMs": 1.0,
                "byHost": {"asset.localhost": 2, "ipc.localhost": 1}
            }
        }))
        .expect("page payload shape");
        let resources = timing.resources.expect("resources parsed");
        assert_eq!(resources.by_host.get("asset.localhost"), Some(&2));
        assert_eq!(resources.by_host.get("ipc.localhost"), Some(&1));
        assert_eq!(
            serde_json::to_value(&resources).unwrap()["byHost"]["asset.localhost"],
            2,
            "写盘后必须还能按 byHost 读回来"
        );
    }

    #[test]
    fn stages_are_emitted_in_declared_order_then_alphabetically() {
        mark("zzz_last");
        mark("setup_enter");
        let keys: Vec<_> = build_report().stages_ms.keys().cloned().collect();
        let position = |k: &str| keys.iter().position(|x| x == k).unwrap();
        assert!(
            position("process_start") < position("setup_enter"),
            "{keys:?}"
        );
        assert!(position("setup_enter") < position("zzz_last"), "{keys:?}");
    }
}
