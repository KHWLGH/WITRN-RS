#[cfg(any(target_os = "linux", test))]
fn environment_locale(mut read: impl FnMut(&str) -> Option<String>) -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| read(key).filter(|value| !value.trim().is_empty()))
        .unwrap_or_default()
}

pub(crate) fn system_locale() -> String {
    #[cfg(target_os = "linux")]
    {
        environment_locale(|key| std::env::var(key).ok())
    }
    #[cfg(not(target_os = "linux"))]
    {
        sys_locale::get_locale().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_priority_ignores_empty_values_and_preserves_posix() {
        let resolve = |values: [Option<&str>; 3]| {
            environment_locale(|key| {
                values[["LC_ALL", "LC_MESSAGES", "LANG"]
                    .iter()
                    .position(|k| *k == key)
                    .unwrap()]
                .map(str::to_owned)
            })
        };
        assert_eq!(
            resolve([Some("ja_JP.UTF-8"), Some("zh_TW"), Some("en_US")]),
            "ja_JP.UTF-8"
        );
        assert_eq!(resolve([Some(" "), Some("zh_HK"), Some("ja_JP")]), "zh_HK");
        assert_eq!(resolve([None, Some(""), Some("C.UTF-8")]), "C.UTF-8");
        assert_eq!(resolve([None, None, None]), "");
    }
}
