//! ChargerLAB POWER-Z KM003C / KM002C USB power meters.
//!
//! The meter exposes two independent paths, and this crate keeps them apart:
//!
//! - [`transport::bulk`] talks to Interface 0 (vendor bulk): ADC samples and the USB-PD
//!   sniffer. [`meter::Meter`] wraps it with the reconnect budget.
//! - [`transport::serial`] talks to the CDC virtual serial port: plain-text commands that
//!   drive the meter's protocol trigger (PDM, PD requests, QC/FCP/SCP/UFCS...).
//!   [`trigger::TriggerSession`] is the state machine on top of it, and [`text`] parses
//!   what the firmware prints back.
//!
//! Nothing here depends on an application framework: callers own the threads and decide
//! how samples and replies reach a UI.

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub mod meter;
pub mod protocol;
pub mod text;
pub mod transport;
pub mod trigger;
pub mod types;

pub use types::{DetectedProtocol, PdmConfig, TriggerCommand, TriggerOutcome, TriggerPdo};

/// Granularity of every interruptible wait: a stop request is noticed within one slice.
const STOP_SLICE: Duration = Duration::from_millis(40);

/// Stop condition shared by long CDC replies and the waits between trigger steps.
///
/// It is set when the owning session stops (`alive` goes false) or when the command in
/// flight is cancelled (`cancel` goes true). The default value never stops, which is
/// what tests and one-off tools want.
#[derive(Clone, Debug, Default)]
pub struct StopSignal {
    alive: Option<Arc<AtomicBool>>,
    cancel: Arc<AtomicBool>,
}

impl StopSignal {
    /// A signal tied to a session's liveness flag and a per-command cancel flag.
    pub fn new(alive: Arc<AtomicBool>, cancel: Arc<AtomicBool>) -> Self {
        Self {
            alive: Some(alive),
            cancel,
        }
    }

    /// Whether the current operation must stop now.
    pub fn is_set(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
            || self
                .alive
                .as_ref()
                .is_some_and(|alive| !alive.load(Ordering::Acquire))
    }

    /// Sleep for `duration`, waking early with an error once the signal is set.
    pub fn sleep(&self, duration: Duration) -> anyhow::Result<()> {
        let deadline = Instant::now() + duration;
        loop {
            if self.is_set() {
                anyhow::bail!("已取消");
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            std::thread::sleep((deadline - now).min(STOP_SLICE));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_signal_follows_session_and_cancel_flags() {
        assert!(!StopSignal::default().is_set());
        let alive = Arc::new(AtomicBool::new(true));
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = StopSignal::new(Arc::clone(&alive), Arc::clone(&cancel));
        assert!(!stop.is_set());
        cancel.store(true, Ordering::Release);
        assert!(stop.is_set());
        cancel.store(false, Ordering::Release);
        alive.store(false, Ordering::Release);
        assert!(stop.is_set());
    }

    #[test]
    fn stopped_sleep_returns_within_one_slice() {
        let cancel = Arc::new(AtomicBool::new(true));
        let stop = StopSignal::new(Arc::new(AtomicBool::new(true)), cancel);
        let started = Instant::now();
        assert_eq!(
            stop.sleep(Duration::from_secs(5)).unwrap_err().to_string(),
            "已取消"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(StopSignal::default()
            .sleep(Duration::from_millis(1))
            .is_ok());
    }
}
