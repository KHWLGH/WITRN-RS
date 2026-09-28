//! The bulk path with the reconnect budget a long recording needs: a few transient
//! failures are ridden out by reopening the handle, an unplug ends the session at once.

use std::time::{Duration, Instant};

use anyhow::Result;

use crate::protocol::{Attribute, DataResponse, ADC_ATTR};
use crate::transport::bulk::{self, BulkDevice};

/// Handshake timeout for the first open.
pub const OPEN_TIMEOUT: Duration = Duration::from_millis(800);
/// Handshake timeout for reopening a lost handle; short so a gone device fails fast.
pub const REOPEN_TIMEOUT: Duration = Duration::from_millis(500);
/// Per-transfer timeout while polling. A healthy round trip takes well under 1 ms.
pub const POLL_TIMEOUT: Duration = Duration::from_millis(200);
/// Pause between losing a handle and trying to reopen it.
pub const REOPEN_DELAY: Duration = Duration::from_millis(500);
/// Consecutive failures, reads and reopens alike, before the session gives up.
pub const FAILURE_BUDGET: u32 = 3;

/// What one [`Meter::step`] did.
#[derive(Debug)]
pub enum Step {
    /// A GetData response that carries the requested ADC block.
    Data(DataResponse),
    /// Nothing to do yet: the handle is down and the next reopen is this far away.
    Idle(Duration),
    /// A lost handle was reopened. The meter may have re-enumerated, so anything bound
    /// to the old enumeration (the CDC port, an entered protocol) is stale.
    Reopened,
}

/// Why the session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// The device went away.
    Unplugged,
    /// The failure budget ran out; the message says what failed last.
    Failed(String),
}

pub struct Meter {
    bus_id: String,
    address: u8,
    serial: Option<String>,
    device: Option<BulkDevice>,
    failures: u32,
    reopen_at: Option<Instant>,
    pub model: &'static str,
}

impl Meter {
    /// Open by bus and address, falling back to the serial number when the meter has
    /// re-enumerated. Errors carry the WinUSB / driver hint from the transport.
    pub fn open(bus_id: &str, address: u8, serial: Option<&str>) -> Result<Self> {
        let mut device = bulk::open_preferred(bus_id, address, serial, OPEN_TIMEOUT)?;
        device.set_timeout(POLL_TIMEOUT);
        let model = device.model;
        Ok(Self {
            bus_id: bus_id.to_string(),
            address,
            serial: serial.map(str::to_string),
            device: Some(device),
            failures: 0,
            reopen_at: None,
            model,
        })
    }

    /// The open handle, for commands outside the polling loop.
    pub fn device_mut(&mut self) -> Option<&mut BulkDevice> {
        self.device.as_mut()
    }

    /// Exactly one action: a GetData round trip while the handle is up; otherwise either
    /// report how long until the next reopen, or make that reopen attempt.
    pub fn step(&mut self, attr: Attribute, now: Instant) -> std::result::Result<Step, Stop> {
        let Some(device) = self.device.as_mut() else {
            let due = self.reopen_at.unwrap_or(now);
            if now < due {
                return Ok(Step::Idle(due - now));
            }
            return match bulk::open_preferred(
                &self.bus_id,
                self.address,
                self.serial.as_deref(),
                REOPEN_TIMEOUT,
            ) {
                Ok(mut device) => {
                    device.set_timeout(POLL_TIMEOUT);
                    self.device = Some(device);
                    self.reopen_at = None;
                    // The budget is only restored by a valid reading, not by a handle.
                    Ok(Step::Reopened)
                }
                Err(error) => self.fail(error, now, "KM003C 重连失败"),
            };
        };
        let response = device.get_data(attr).and_then(|response| {
            anyhow::ensure!(
                attr.bits() & ADC_ATTR == 0 || response.adc.is_some(),
                "KM003C 未返回有效 ADC 数据"
            );
            Ok(response)
        });
        match response {
            Ok(response) => {
                self.failures = 0;
                Ok(Step::Data(response))
            }
            Err(error) => {
                self.device = None;
                self.fail(error, now, "KM003C 读取失败")
            }
        }
    }

    fn fail(
        &mut self,
        error: anyhow::Error,
        now: Instant,
        context: &str,
    ) -> std::result::Result<Step, Stop> {
        if failure_is_terminal(&mut self.failures, &error) {
            return Err(if bulk::is_disconnected(&error) {
                Stop::Unplugged
            } else {
                Stop::Failed(format!("{context}: {error:#}"))
            });
        }
        self.reopen_at = Some(now + REOPEN_DELAY);
        Ok(Step::Idle(REOPEN_DELAY))
    }
}

/// Count one failure; an unplug is terminal at once, anything else after the budget.
fn failure_is_terminal(failures: &mut u32, error: &anyhow::Error) -> bool {
    *failures += 1;
    bulk::is_disconnected(error) || *failures >= FAILURE_BUDGET
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_budget_is_not_reset_by_reopening_a_handle() {
        let mut failures = 0;
        let error = anyhow::anyhow!("USB IN 超时");
        assert!(!failure_is_terminal(&mut failures, &error));
        assert!(!failure_is_terminal(&mut failures, &error));
        assert!(failure_is_terminal(&mut failures, &error));
    }

    #[test]
    fn an_unplug_is_terminal_on_the_first_failure() {
        let mut failures = 0;
        let error = anyhow::Error::new(nusb::transfer::TransferError::Disconnected);
        assert!(failure_is_terminal(&mut failures, &error));
    }
}
