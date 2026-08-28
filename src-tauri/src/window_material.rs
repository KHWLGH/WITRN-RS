//! Win11 Mica 窗口材质。非 Windows 或 DWM 不支持时全部命令空操作并报告不可用。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{window::Color, AppHandle, Manager, State, WebviewWindow};

use crate::AppState;

/// WebView2 在 alpha≠0 时会把底色打成不透明；Mica 必须用全透明画布。
const WEBVIEW_TRANSPARENT: Color = Color(0, 0, 0, 0);
/// Fluent grey-12，关 Mica 时的深色回退，避免看穿桌面。
const WEBVIEW_FALLBACK_DARK: Color = Color(0x1f, 0x1f, 0x1f, 0xff);
/// Fluent grey-98，关 Mica 时的浅色回退。
const WEBVIEW_FALLBACK_LIGHT: Color = Color(0xfa, 0xfa, 0xfa, 0xff);

/// 与 AppState.window_material_enabled 同步，供 WM_NCACTIVATE 子类读取。
static MATERIAL_ENABLED: AtomicBool = AtomicBool::new(false);
/// 用户偏好：非聚焦时仍按激活态绘制系统背景（Mica / Tabbed）。
static KEEP_UNFOCUSED: AtomicBool = AtomicBool::new(false);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn sync_webview_background(window: &WebviewWindow, mica: bool, dark: bool) {
    let color = if mica {
        WEBVIEW_TRANSPARENT
    } else if dark {
        WEBVIEW_FALLBACK_DARK
    } else {
        WEBVIEW_FALLBACK_LIGHT
    };
    if let Err(error) = window.set_background_color(Some(color)) {
        eprintln!("设置窗口背景色失败: {error}");
    }
}

fn store_enabled(state: &AppState, enabled: bool) {
    state
        .window_material_enabled
        .store(enabled, Ordering::Relaxed);
    MATERIAL_ENABLED.store(enabled, Ordering::Relaxed);
}

#[cfg(windows)]
fn apply_mica_on(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    match window_vibrancy::apply_tabbed(window, Some(dark)) {
        Ok(()) => Ok(()),
        Err(_) => {
            window_vibrancy::apply_mica(window, Some(dark)).map_err(|error| error.to_string())
        }
    }
}

#[cfg(windows)]
fn clear_mica_on(window: &WebviewWindow) -> Result<(), String> {
    let _ = window_vibrancy::clear_tabbed(window);
    let _ = window_vibrancy::clear_mica(window);
    Ok(())
}

#[cfg(not(windows))]
fn apply_mica_on(_window: &WebviewWindow, _dark: bool) -> Result<(), String> {
    Err("当前平台不支持 Mica".into())
}

#[cfg(not(windows))]
fn clear_mica_on(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

pub fn try_enable_on_setup(window: &WebviewWindow, state: &AppState, dark: bool) {
    match apply_mica_on(window, dark) {
        Ok(()) => {
            state
                .window_material_available
                .store(true, Ordering::Relaxed);
            store_enabled(state, true);
            sync_webview_background(window, true, dark);
            #[cfg(windows)]
            ncactivate::install(window);
        }
        Err(error) => {
            eprintln!("窗口材质不可用: {error}");
            sync_webview_background(window, false, dark);
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterialInfo {
    pub available: bool,
    pub applied: bool,
}

fn info(state: &AppState) -> WindowMaterialInfo {
    WindowMaterialInfo {
        available: state.window_material_available.load(Ordering::Relaxed),
        applied: state.window_material_enabled.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn get_window_material(state: State<'_, AppState>) -> WindowMaterialInfo {
    info(&state)
}

#[tauri::command]
pub fn set_window_material_theme(
    dark: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let window = main_window(&app).ok_or("找不到主窗口")?;
    let enabled = state.window_material_enabled.load(Ordering::Relaxed);
    if enabled {
        apply_mica_on(&window, dark)?;
    }
    sync_webview_background(&window, enabled, dark);
    Ok(())
}

#[tauri::command]
pub fn set_window_material_enabled(
    enabled: bool,
    dark: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WindowMaterialInfo, String> {
    if !state.window_material_available.load(Ordering::Relaxed) {
        return Ok(info(&state));
    }
    let window = main_window(&app).ok_or("找不到主窗口")?;
    if enabled {
        apply_mica_on(&window, dark)?;
        store_enabled(&state, true);
        sync_webview_background(&window, true, dark);
    } else {
        clear_mica_on(&window)?;
        store_enabled(&state, false);
        sync_webview_background(&window, false, dark);
    }
    #[cfg(windows)]
    ncactivate::sync_appearance(&window);
    Ok(info(&state))
}

#[tauri::command]
pub fn set_window_material_unfocused(
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WindowMaterialInfo, String> {
    KEEP_UNFOCUSED.store(enabled, Ordering::Relaxed);
    if !state.window_material_available.load(Ordering::Relaxed) {
        return Ok(info(&state));
    }
    let window = main_window(&app).ok_or("找不到主窗口")?;
    #[cfg(windows)]
    ncactivate::sync_appearance(&window);
    #[cfg(not(windows))]
    let _ = window;
    Ok(info(&state))
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
