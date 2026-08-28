//! Win11 Mica 窗口材质。非 Windows 或 DWM 不支持时全部命令空操作并报告不可用。

use std::sync::atomic::Ordering;
use tauri::{window::Color, AppHandle, Manager, State, WebviewWindow};

use crate::AppState;

/// WebView2 在 alpha≠0 时会把底色打成不透明；Mica 必须用全透明画布。
const WEBVIEW_TRANSPARENT: Color = Color(0, 0, 0, 0);
/// Fluent grey-12，关 Mica 时的深色回退，避免看穿桌面。
const WEBVIEW_FALLBACK_DARK: Color = Color(0x1f, 0x1f, 0x1f, 0xff);
/// Fluent grey-98，关 Mica 时的浅色回退。
const WEBVIEW_FALLBACK_LIGHT: Color = Color(0xfa, 0xfa, 0xfa, 0xff);

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

#[cfg(windows)]
fn apply_mica_on(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    match window_vibrancy::apply_tabbed(window, Some(dark)) {
        Ok(()) => Ok(()),
        Err(_) => window_vibrancy::apply_mica(window, Some(dark)).map_err(|error| error.to_string()),
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
            state.window_material_enabled.store(true, Ordering::Relaxed);
            sync_webview_background(window, true, dark);
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
        state.window_material_enabled.store(true, Ordering::Relaxed);
        sync_webview_background(&window, true, dark);
    } else {
        clear_mica_on(&window)?;
        state.window_material_enabled.store(false, Ordering::Relaxed);
        sync_webview_background(&window, false, dark);
    }
    Ok(info(&state))
}
