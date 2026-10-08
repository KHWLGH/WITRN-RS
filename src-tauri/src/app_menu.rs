//! macOS 应用菜单：在 Tauri 默认菜单的「About」之后加「Settings…」（⌘,）。
//!
//! macOS 应用的设置统一放在应用菜单、快捷键 ⌘,。默认菜单没有这一项，⌘, 也就
//! 没有任何反应。菜单项只发 `open-settings` 事件，由前端切到设置页，与标题栏
//! 齿轮按钮走同一条路径。其余菜单项沿用 Tauri 默认（与系统语言无关，均为英文），
//! 这一项也用英文以保持一致。

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

/// 菜单项 id，同时是发给前端的事件名。
pub(crate) const OPEN_SETTINGS: &str = "open-settings";

/// Tauri 默认菜单，应用菜单中插入 Settings… 与一条分隔线。
pub(crate) fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let settings =
            MenuItem::with_id(app, OPEN_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
        // About / 分隔线 / Settings… / 分隔线 / Services …
        app_menu.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
    }
    Ok(menu)
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == OPEN_SETTINGS {
        let _ = app.emit(OPEN_SETTINGS, ());
    }
}
