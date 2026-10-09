//! 采集期间让 macOS 不对本进程启用 App Nap，录制期间再阻止系统空闲睡眠。
//!
//! 窗口全部隐藏、最小化或被完全遮挡时，macOS 可能对整个进程启用 App Nap：
//! 定时器被合并、I/O 被节流、线程降到后台优先级，采集线程于是迟醒。hidapi 的
//! macOS 后端每台设备最多缓存 30 份输入报告，超出即丢弃最旧的一份，1 ms 采样下
//! 迟醒约 30 ms 就会丢数据；发射线程 8–50 ms 的合批定时器同样会被合并。
//!
//! `NSProcessInfo` 的 user-initiated activity 在读线程存活期间退出 App Nap，
//! 读线程结束（停止、拔线或出错）即随之释放，进程退出时由系统回收。
//!
//! 只退出 App Nap 还不够：窗口最小化后进程不再是前台焦点，读线程偶尔仍会迟醒。
//! WITRN K2 以 100 次/秒采集、最小化 3 分钟实测，样本间隔最大 36 ms，迟到的
//! 报告按主机接收时刻打戳后挤进同一个 10 ms 选择窗口，约 0.2–1% 的点被合并；
//! 窗口可见时为 100%。activity 加上 `LatencyCritical`（要求最高的定时器与 I/O
//! 精度）后，同样条件下最大间隔 18.8 ms，39 个 5 秒窗口全部 100% 保留，进程 CPU
//! 多约 1 个百分点。
//!
//! 只采集不录制时允许系统空闲睡眠；录制段打开期间换成同时阻止空闲睡眠的
//! activity（相当于 `caffeinate -i`），无人值守的长时间录制不会因 Mac 自动睡眠
//! 而中断。屏幕照常熄灭，合盖和手动睡眠不受影响。

#[cfg(target_os = "macos")]
const ACQUIRING_REASON: &str = "laPower is acquiring measurements";
const RECORDING_REASON: &str = "laPower is recording measurements";

/// 读线程持有的 activity；drop 时结束。
pub(crate) struct AcquisitionActivity {
    recording: bool,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    recording_reason: &'static str,
    #[cfg(target_os = "macos")]
    token: macos::Activity,
}

impl AcquisitionActivity {
    pub(crate) fn begin() -> Self {
        Self::begin_with(RECORDING_REASON)
    }

    fn begin_with(recording_reason: &'static str) -> Self {
        Self {
            recording: false,
            recording_reason,
            #[cfg(target_os = "macos")]
            token: macos::Activity::begin(macos::ACQUIRING, ACQUIRING_REASON),
        }
    }

    /// 录制段打开（`true`）期间阻止系统空闲睡眠；暂停、停止录制（`false`）后恢复为只退出 App Nap。
    pub(crate) fn set_recording(&mut self, recording: bool) {
        if self.recording == recording {
            return;
        }
        self.recording = recording;
        #[cfg(target_os = "macos")]
        {
            let next = if recording {
                macos::Activity::begin(macos::RECORDING, self.recording_reason)
            } else {
                macos::Activity::begin(macos::ACQUIRING, ACQUIRING_REASON)
            };
            // 先开始新的再结束旧的，切换时不留 App Nap 的空档。
            drop(std::mem::replace(&mut self.token, next));
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// 退出 App Nap、保持定时器精度，允许系统空闲睡眠。
    pub(super) const ACQUIRING: NSActivityOptions = NSActivityOptions(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep.0
            | NSActivityOptions::LatencyCritical.0,
    );
    /// 在 `ACQUIRING` 之外再阻止系统空闲睡眠；不阻止屏幕熄灭。
    pub(super) const RECORDING: NSActivityOptions = NSActivityOptions(
        NSActivityOptions::UserInitiated.0 | NSActivityOptions::LatencyCritical.0,
    );

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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn activity_begins_and_ends_with_its_owner() {
        let first = AcquisitionActivity::begin();
        let mut second = AcquisitionActivity::begin();
        second.set_recording(true);
        drop(first);
        drop(second);
    }

    /// `pmset -g assertions` 中以 `reason` 命名、阻止空闲睡眠的断言数。
    #[cfg(target_os = "macos")]
    fn idle_sleep_assertions_named(reason: &str) -> usize {
        let output = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset is part of every macOS installation");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains(reason) && line.contains("PreventUserIdleSystemSleep"))
            .count()
    }

    /// 只采集时是否空闲睡眠仍由用户的系统设置决定。
    #[cfg(target_os = "macos")]
    #[test]
    fn acquisition_never_holds_an_idle_sleep_assertion() {
        let reason = format!("lapower-test-acquiring-{}", std::process::id());
        let activity = macos::Activity::begin(macos::ACQUIRING, &reason);
        assert_eq!(
            idle_sleep_assertions_named(&reason),
            0,
            "acquisition must not prevent idle sleep"
        );
        drop(activity);
    }

    /// 录制段打开期间恰好持有一个空闲睡眠断言，暂停或读线程结束即释放。
    #[cfg(target_os = "macos")]
    #[test]
    fn only_an_open_recording_segment_prevents_idle_sleep() {
        // 读线程的测试也会打开录制段，用独立的名字区分。
        let reason: &'static str =
            Box::leak(format!("lapower-test-recording-{}", std::process::id()).into_boxed_str());
        let mut activity = AcquisitionActivity::begin_with(reason);
        assert_eq!(idle_sleep_assertions_named(reason), 0);
        activity.set_recording(true);
        activity.set_recording(true);
        assert_eq!(
            idle_sleep_assertions_named(reason),
            1,
            "recording keeps the Mac awake"
        );
        activity.set_recording(false);
        assert_eq!(
            idle_sleep_assertions_named(reason),
            0,
            "pausing lets it sleep again"
        );
        activity.set_recording(true);
        drop(activity);
        assert_eq!(
            idle_sleep_assertions_named(reason),
            0,
            "the reader ending releases it"
        );
    }
}
