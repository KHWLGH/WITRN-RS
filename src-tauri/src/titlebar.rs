//! macOS 原生标题栏的双击行为。
//!
//! 系统红绿灯所在的标题栏是叠在网页上的透明 Overlay，系统标题栏收不到双击。前端在
//! 标题栏空白处检测到双击后调用这里，按「系统设置 › 桌面与程序坞 › 连按窗口标题栏以…」
//! 执行，与原生窗口一致。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DoubleClickAction {
    /// 「缩放」，以及 macOS 15 起的「填充」。
    Zoom,
    Minimize,
    /// 「不执行任何操作」。
    Ignore,
}

/// `AppleActionOnDoubleClick` 的取值为 Maximize（缩放）、Fill（填充）、Minimize 或 None；
/// 较早的系统只有布尔键 `AppleMiniaturizeOnDoubleClick`。都没有时系统默认缩放。
pub(crate) fn double_click_action(
    action: Option<&str>,
    legacy_minimize: bool,
) -> DoubleClickAction {
    match action {
        Some("Minimize") => DoubleClickAction::Minimize,
        Some("None") => DoubleClickAction::Ignore,
        Some(_) => DoubleClickAction::Zoom,
        None if legacy_minimize => DoubleClickAction::Minimize,
        None => DoubleClickAction::Zoom,
    }
}

#[cfg(target_os = "macos")]
fn system_double_click_action() -> DoubleClickAction {
    use objc2_foundation::{NSString, NSUserDefaults};

    // 标准用户默认值的搜索列表包含 NSGlobalDomain，系统设置就写在那里。
    let defaults = NSUserDefaults::standardUserDefaults();
    let action = defaults
        .stringForKey(&NSString::from_str("AppleActionOnDoubleClick"))
        .map(|value| value.to_string());
    let legacy_minimize = defaults.boolForKey(&NSString::from_str("AppleMiniaturizeOnDoubleClick"));
    double_click_action(action.as_deref(), legacy_minimize)
}

#[cfg(not(target_os = "macos"))]
fn system_double_click_action() -> DoubleClickAction {
    double_click_action(None, false)
}

#[tauri::command]
pub(crate) fn titlebar_double_click(window: tauri::WebviewWindow) -> Result<(), String> {
    let result = match system_double_click_action() {
        DoubleClickAction::Minimize => window.minimize(),
        DoubleClickAction::Ignore => Ok(()),
        DoubleClickAction::Zoom => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            Ok(false) => window.maximize(),
            Err(error) => Err(error),
        },
    };
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_click_follows_the_system_setting() {
        assert_eq!(
            double_click_action(Some("Maximize"), false),
            DoubleClickAction::Zoom
        );
        assert_eq!(
            double_click_action(Some("Fill"), false),
            DoubleClickAction::Zoom
        );
        assert_eq!(
            double_click_action(Some("Minimize"), false),
            DoubleClickAction::Minimize
        );
        assert_eq!(
            double_click_action(Some("None"), false),
            DoubleClickAction::Ignore
        );
    }

    #[test]
    fn the_current_setting_wins_over_the_legacy_key() {
        assert_eq!(
            double_click_action(Some("None"), true),
            DoubleClickAction::Ignore
        );
        assert_eq!(
            double_click_action(Some("Maximize"), true),
            DoubleClickAction::Zoom
        );
        assert_eq!(double_click_action(None, true), DoubleClickAction::Minimize);
        assert_eq!(double_click_action(None, false), DoubleClickAction::Zoom);
    }
}
