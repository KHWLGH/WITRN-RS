//! Windows Mica / Tabbed 与 macOS Vibrancy；不可用或失败时使用不透明底色。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{window::Color, AppHandle, Manager, State, WebviewWindow};

use crate::AppState;

/// WebView2 不支持半透明画布；仅在原生材质成功后使用全透明底色。
const WEBVIEW_TRANSPARENT: Color = Color(0, 0, 0, 0);
const WEBVIEW_FALLBACK_DARK: Color = Color(0x1f, 0x1f, 0x1f, 0xff);
const WEBVIEW_FALLBACK_LIGHT: Color = Color(0xfa, 0xfa, 0xfa, 0xff);

/// 实际应用状态，不是用户持久化偏好。供 WM_NCACTIVATE 子类读取。
static MATERIAL_ENABLED: AtomicBool = AtomicBool::new(false);
static KEEP_UNFOCUSED: AtomicBool = AtomicBool::new(false);
static MATERIAL_DARK: AtomicBool = AtomicBool::new(true);

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

fn sync_webview_background(
    window: &WebviewWindow,
    applied: bool,
    dark: bool,
) -> Result<(), String> {
    let color = if applied {
        WEBVIEW_TRANSPARENT
    } else if dark {
        WEBVIEW_FALLBACK_DARK
    } else {
        WEBVIEW_FALLBACK_LIGHT
    };
    // macOS 的 WKWebView 背景设置不受支持；原生窗口底色与前端不透明 CSS 共同回退。
    window
        .set_background_color(Some(color))
        .map_err(|error| error.to_string())
}

fn store_enabled(state: &AppState, enabled: bool) {
    state
        .window_material_enabled
        .store(enabled, Ordering::Relaxed);
    MATERIAL_ENABLED.store(enabled, Ordering::Relaxed);
}

// 所有原生 apply/clear 调用仅由下方主线程闭包执行。
#[cfg(windows)]
fn apply_material_on(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    window_vibrancy::apply_tabbed(window, Some(dark))
        .or_else(|_| window_vibrancy::apply_mica(window, Some(dark)))
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn clear_material_on(window: &WebviewWindow) -> Result<(), String> {
    // 两种效果使用同一 DWM backdrop；任一成功即可，不能吞掉两者均失败。
    window_vibrancy::clear_tabbed(window)
        .or_else(|_| window_vibrancy::clear_mica(window))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn apply_material_on(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};

    window
        .set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .map_err(|error| error.to_string())?;
    // 0.6 每次 apply 都添加一个 NSVisualEffectView，重应用前先清理，避免叠加。
    clear_material_on(window)?;
    let active_state = if KEEP_UNFOCUSED.load(Ordering::Relaxed) {
        NSVisualEffectState::Active
    } else {
        NSVisualEffectState::FollowsWindowActiveState
    };
    window_vibrancy::apply_vibrancy(
        window,
        NSVisualEffectMaterial::WindowBackground,
        Some(active_state),
        None,
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn clear_material_on(window: &WebviewWindow) -> Result<(), String> {
    // Ok(false) 表示尚无该材质视图，同样是成功清理状态。
    window_vibrancy::clear_vibrancy(window)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn apply_material_on(_window: &WebviewWindow, _dark: bool) -> Result<(), String> {
    Err("当前平台不支持原生窗口材质".into())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn clear_material_on(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

fn fallback_on(window: &WebviewWindow, state: &AppState, dark: bool) -> Result<(), String> {
    store_enabled(state, false);
    // 先遮住透明画布，即使清理原生材质失败也不能留下透底窗口。
    let background = sync_webview_background(window, false, dark);
    let cleared = clear_material_on(window);
    #[cfg(windows)]
    ncactivate::sync_appearance(window);
    background.and(cleared)
}

fn set_enabled_on_main(
    window: &WebviewWindow,
    state: &AppState,
    enabled: bool,
    dark: bool,
) -> Result<WindowMaterialInfo, String> {
    MATERIAL_DARK.store(dark, Ordering::Relaxed);
    if !cfg!(any(windows, target_os = "macos")) {
        state
            .window_material_available
            .store(false, Ordering::Relaxed);
        fallback_on(window, state, dark)?;
    } else if enabled {
        let applied = apply_material_on(window, dark)
            .and_then(|_| sync_webview_background(window, true, dark));
        if let Err(error) = applied {
            state
                .window_material_available
                .store(false, Ordering::Relaxed);
            if let Err(fallback_error) = fallback_on(window, state, dark) {
                return Err(format!("{error}; 不透明回退: {fallback_error}"));
            }
            return Err(error);
        }
        state
            .window_material_available
            .store(true, Ordering::Relaxed);
        store_enabled(state, true);
        #[cfg(windows)]
        {
            ncactivate::install(window);
            ncactivate::sync_appearance(window);
        }
    } else {
        fallback_on(window, state, dark)?;
    }
    Ok(info(state))
}

/// setup 也显式调度到主线程；不等待 UI 线程，避免同步通道造成死锁。
/// lib.rs 应在各桌面平台调用；Linux 会设置不透明底色而不启用材质。
pub fn try_enable_on_setup(window: &WebviewWindow, state: &AppState, dark: bool) {
    let target = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        let state = target.state::<AppState>();
        if let Err(error) = set_enabled_on_main(&target, &state, true, dark) {
            eprintln!("窗口材质不可用: {error}");
        }
    }) {
        state
            .window_material_available
            .store(false, Ordering::Relaxed);
        store_enabled(state, false);
        if let Err(background_error) = sync_webview_background(window, false, dark) {
            eprintln!("设置窗口回退底色失败: {background_error}");
        }
        eprintln!("调度窗口材质失败: {error}");
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterialInfo {
    pub available: bool,
    pub applied: bool,
    pub platform: &'static str,
}

fn info(state: &AppState) -> WindowMaterialInfo {
    WindowMaterialInfo {
        available: state.window_material_available.load(Ordering::Relaxed),
        applied: state.window_material_enabled.load(Ordering::Relaxed),
        platform: platform(),
    }
}

/// 命令异步等待一个容量为 1 的回执，不阻塞主线程，也不引入额外依赖。
async fn on_main_thread<T, F>(app: AppHandle, action: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&WebviewWindow, &AppState) -> Result<T, String> + Send + 'static,
{
    let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
    let target = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let state = app.state::<AppState>();
            let _ = sender.try_send(action(&target, &state));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "窗口材质主线程任务已取消".to_string())?
}

#[tauri::command]
pub fn get_window_material(state: State<'_, AppState>) -> WindowMaterialInfo {
    info(&state)
}

#[tauri::command]
pub async fn set_window_material_theme(dark: bool, app: AppHandle) -> Result<(), String> {
    on_main_thread(app, move |window, state| {
        let enabled = state.window_material_enabled.load(Ordering::Relaxed);
        set_enabled_on_main(window, state, enabled, dark).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn set_window_material_enabled(
    enabled: bool,
    dark: bool,
    app: AppHandle,
) -> Result<WindowMaterialInfo, String> {
    // 不因上次失败锁死开关；允许明确的用户请求再次尝试。
    on_main_thread(app, move |window, state| {
        set_enabled_on_main(window, state, enabled, dark)
    })
    .await
}

#[tauri::command]
pub async fn set_window_material_unfocused(
    enabled: bool,
    app: AppHandle,
) -> Result<WindowMaterialInfo, String> {
    on_main_thread(app, move |window, state| {
        KEEP_UNFOCUSED.store(enabled, Ordering::Relaxed);
        #[cfg(target_os = "macos")]
        if state.window_material_enabled.load(Ordering::Relaxed) {
            return set_enabled_on_main(window, state, true, MATERIAL_DARK.load(Ordering::Relaxed));
        }
        #[cfg(windows)]
        ncactivate::sync_appearance(window);
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = window;
        Ok(info(state))
    })
    .await
}

/// DWM 根据 `WM_NCACTIVATE` 把系统背景收成纯色。拦截失活消息并报告仍为激活，
/// 非聚焦窗口即可继续使用 Mica / Tabbed。
#[cfg(windows)]
mod ncactivate {
    use super::{KEEP_UNFOCUSED, MATERIAL_ENABLED};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_NCACTIVATE, WM_NCDESTROY};

    const SUBCLASS_ID: usize = u32::from_le_bytes(*b"WMat") as usize;
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    fn keep_active_now() -> bool {
        MATERIAL_ENABLED.load(Ordering::Relaxed) && KEEP_UNFOCUSED.load(Ordering::Relaxed)
    }

    fn raw_hwnd(window: &WebviewWindow) -> Option<HWND> {
        window.hwnd().ok().map(|hwnd| hwnd.0)
    }

    pub(super) fn install(window: &WebviewWindow) {
        if INSTALLED.load(Ordering::Relaxed) {
            return;
        }
        let Some(hwnd) = raw_hwnd(window) else {
            return;
        };
        // SAFETY: hwnd 是本进程主窗口；subclass_proc 与进程同寿命。
        let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) != 0 };
        if ok {
            INSTALLED.store(true, Ordering::Relaxed);
        } else {
            eprintln!("无法安装窗口材质子类，非聚焦材质选项将不可用");
        }
    }

    pub(super) fn sync_appearance(window: &WebviewWindow) {
        let Some(hwnd) = raw_hwnd(window) else {
            return;
        };
        let report_active = keep_active_now() || window.is_focused().unwrap_or(false);
        // SAFETY: hwnd 来自仍存活的主窗口；lParam=-1 跳过 NC 重绘。
        unsafe {
            SendMessageW(hwnd, WM_NCACTIVATE, if report_active { 1 } else { 0 }, -1);
        }
    }

    // SAFETY: 仅由 SetWindowSubclass 对仍有效的 hwnd 调用；WM_NCDESTROY 时拆除子类。
    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid: usize,
        _ref_data: usize,
    ) -> LRESULT {
        match msg {
            WM_NCDESTROY => {
                INSTALLED.store(false, Ordering::Relaxed);
                RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            WM_NCACTIVATE if wparam == 0 && keep_active_now() => {
                // wParam=TRUE：DWM 继续按激活态绘制系统背景。
                // lParam=-1：跳过非客户区重绘（无边框窗口也避免多余 NC paint）。
                DefSubclassProc(hwnd, msg, 1, -1)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }
}
