//! 采集期间让 macOS 不对本进程启用 App Nap。
//!
//! 窗口全部隐藏、最小化或被完全遮挡时，macOS 可能对整个进程启用 App Nap：
//! 定时器被合并、I/O 被节流、线程降到后台优先级，采集线程于是迟醒。hidapi 的
//! macOS 后端每台设备最多缓存 30 份输入报告，超出即丢弃最旧的一份，1 ms 采样下
//! 迟醒约 30 ms 就会丢数据；发射线程 8–50 ms 的合批定时器同样会被合并。
//!
//! `NSProcessInfo` 的 user-initiated activity 在读线程存活期间退出 App Nap，
//! 读线程结束（停止、拔线或出错）即随之释放。它不阻止系统睡眠，进程退出时由
//! 系统回收。

/// 读线程持有的 activity；drop 时结束。
pub(crate) struct AcquisitionActivity {
    #[cfg(target_os = "macos")]
    _token: macos::Activity,
}

impl AcquisitionActivity {
    pub(crate) fn begin() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            _token: macos::Activity::begin(macos::OPTIONS, macos::REASON),
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    pub(super) const REASON: &str = "laPower is acquiring measurements";
    /// 只退出 App Nap，允许系统空闲睡眠。
    pub(super) const OPTIONS: NSActivityOptions =
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep;

    pub(super) struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    impl Activity {
        pub(super) fn begin(options: NSActivityOptions, reason: &str) -> Self {
            let reason = NSString::from_str(reason);
            Self(NSProcessInfo::processInfo().beginActivityWithOptions_reason(options, &reason))
        }
    }

    impl Drop for Activity {
        fn drop(&mut self) {
            // SAFETY: token 由同一个进程级 NSProcessInfo 的
            // beginActivityWithOptions:reason: 返回，且只结束一次。
            unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_begins_and_ends_with_its_owner() {
        let first = AcquisitionActivity::begin();
        let second = AcquisitionActivity::begin();
        drop(first);
        drop(second);
    }

    /// 采集只退出 App Nap；是否允许空闲睡眠仍由用户的系统设置决定。
    #[cfg(target_os = "macos")]
    #[test]
    fn acquisition_never_holds_an_idle_sleep_assertion() {
        let reason = format!("lapower-test-{}", std::process::id());
        let activity = macos::Activity::begin(macos::OPTIONS, &reason);
        let output = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset is part of every macOS installation");
        let assertions = String::from_utf8_lossy(&output.stdout);
        assert!(
            !assertions
                .lines()
                .any(|line| line.contains(&reason) && line.contains("PreventUserIdleSystemSleep")),
            "acquisition must not prevent idle sleep:\n{assertions}"
        );
        drop(activity);
    }
}
