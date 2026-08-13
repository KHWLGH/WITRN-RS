//! Read and decode the HID stream from a WITRN USB power meter.
//!
//! A Rust port of the [`witrnhid`](https://github.com/JohnScotttt/WITRN_HID_API)
//! Python package. WITRN meters (K2, U3, C5 …) stream 64-byte HID reports of two
//! kinds: measurement samples, and captured USB-PD traffic. This crate opens the
//! device, reads reports, and unpacks both into the
//! [`Metadata`] tree that [`usbpd_parser`] defines.
//!
//! ```no_run
//! use witrn_hid::{ReportKind, WitrnDev};
//!
//! let mut dev = WitrnDev::new();
//! dev.open()?;                       // or open_vid_pid / open_path
//!
//! loop {
//!     let report = dev.read_data()?;
//!     match ReportKind::of(report) {
//!         Some(ReportKind::General) => {
//!             let (at, msg) = dev.general_unpack(None)?;
//!             let volts = msg.get("VBus").unwrap().value();
//!             let amps = msg.get("Current").unwrap().value();
//!             println!("{at}  {volts}  {amps}");
//!         }
//!         Some(ReportKind::Pd) => {
//!             let (at, msg) = dev.pd_unpack(None, None, None, None)?;
//!             println!("{at}  {}", usbpd_parser::to_plain(&usbpd_parser::render(&msg, 1)));
//!         }
//!         Some(_) | None => {}
//!     }
//! }
//! # Ok::<_, witrn_hid::Error>(())
//! ```
//!
//! # PD context
//!
//! PD messages are not self-describing: a `Request` names an object position within
//! the `Source_Capabilities` before it, and chunked extended messages span several
//! reports. [`WitrnDev`] holds a [`Parser`] that tracks this
//! across the stream, so the no-argument unpack methods just work. If you keep your
//! own message history — for scrubbing back through a capture, say — pass the
//! context explicitly and the device's own state is left alone.
//!
//! # Device identity
//!
//! A few bytes of every general report hold still for a given meter — enough to
//! tell two meters apart without ever writing to one. The firmware version is
//! *not* among them; see [`info`] for what the stream does and does not carry.
//!
//! ```no_run
//! # use witrn_hid::WitrnDev;
//! # let mut dev = WitrnDev::new();
//! # dev.open()?;
//! let id = dev.identity(2000)?;
//! println!("{id}  {}", id.fingerprint());
//! # Ok::<_, witrn_hid::Error>(())
//! ```
//!
//! # Features
//!
//! - `serde` *(default)* — `Serialize` for the parsed tree, for handing it to a UI.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod device;
mod error;
mod general;
pub mod info;

pub use device::{decode_pd_report, ReportKind, Unpacked, WitrnDev, K2_PID, WITRN_VID};
pub use error::{Error, Result};
pub use general::{decode_general_sample, fields, general_msg, GeneralSample, REPORT_LEN};
pub use info::Identity;

// Re-exported so callers need not depend on the parser crate directly.
pub use usbpd_parser;
pub use usbpd_parser::{Metadata, ParseOptions, Parser, Sop, Value};

/// The version of the [`witrnhid`] Python package this port tracks.
///
/// `witrnhid` and `usbpdparser` are released separately, so this does not have to
/// match [`usbpd_parser::UPSTREAM_VERSION`] — and currently does not.
///
/// [`witrnhid`]: https://github.com/JohnScotttt/WITRN_HID_API
pub const UPSTREAM_VERSION: &str = "1.1.5";
