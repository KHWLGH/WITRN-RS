//! Telling meters apart, without writing to them.
//!
//! Bytes 8..16 of a general (`0xFF`) report are not measurement data. While the
//! meter is just streaming they hold a block that never moves; while it is
//! answering some other program they hold `[0x0A] [length] [payload…]` instead.
//! Three bytes of that block, and six more in the configuration block at the
//! end of the report, hold still for a given meter across reconnects and
//! reboots — enough to stand in for a name.
//!
//! ```text
//! …FF 55 xx xx xx xx xx xx  1A 34 00 00 50 00  5C 29 …
//!                           ^marker  ^^^^^^^^ signature
//! ```
//!
//! # No firmware version
//!
//! Byte 12 is `0x50` on a K2 running V5.0 and on a C5 running V8.3, so it is a
//! fixed marker, not a version — reading it as two BCD nibbles happened to
//! match the K2 and nothing more. No other byte of the stream tracks the
//! version either: both meters' HID report descriptors are byte-identical and
//! declare one 64-byte input and one 64-byte output report, with no feature
//! report to ask for it. The meter's own software reads the version out of
//! flash, which takes a write, and this crate does not write — the output
//! endpoint stops being serviced the moment it receives one malformed report
//! and stays that way until the device is re-enumerated.

use std::fmt;

use crate::error::{Error, Result};
use crate::general::REPORT_LEN;

/// Where the identity block sits inside a general report.
const INFO: std::ops::Range<usize> = 8..16;
/// Byte 8 while the meter is answering somebody's request.
const BUSY: u8 = 0x0A;

/// The two runs of report bytes that hold still for a given meter.
const SIGNATURE_PARTS: [std::ops::Range<usize>; 2] = [9..12, 56..62];
/// How many bytes [`signature`] returns.
pub const SIGNATURE_LEN: usize = 9;

/// The bytes of a general report that never move for a given meter.
///
/// Two short runs either side of the measurements: the tail of the identity
/// block, and the configuration block at the end. Every report a meter sends
/// carries the same values there, across reconnects and reboots, so they can
/// stand in for a name — see [`Identity`].
///
/// `None` when the report cannot be trusted for this: the identity block is
/// carrying somebody's reply, so its bytes are that reply's payload rather than
/// the meter's own.
pub fn signature(report: &[u8]) -> Result<Option<[u8; SIGNATURE_LEN]>> {
    let block = info_block(report)?;
    if block[0] == BUSY {
        return Ok(None);
    }
    let mut sig = [0u8; SIGNATURE_LEN];
    let mut at = 0;
    for part in SIGNATURE_PARTS {
        let len = part.len();
        sig[at..at + len].copy_from_slice(&report[part]);
        at += len;
    }
    Ok(Some(sig))
}

fn info_block(report: &[u8]) -> Result<&[u8]> {
    if report.len() < REPORT_LEN {
        return Err(Error::ShortReport { len: report.len() });
    }
    if report[0] != 0xFF {
        return Err(Error::UnknownReport { kind: report[0] });
    }
    Ok(&report[INFO])
}

/// What a meter can be told apart by, gathered without writing to it.
///
/// Different fields separate different things, and it is worth being precise
/// about which:
///
/// | Field | Separates |
/// | --- | --- |
/// | [`vendor_id`](Self::vendor_id), [`product_id`](Self::product_id) | models — every K2 shares them, and a revised model keeps its predecessor's |
/// | [`usb_serial`](Self::usb_serial) | a date on WITRN hardware, so a production batch rather than a unit |
/// | [`signature`](Self::signature) | the meter's own fixed report bytes |
/// | [`path`](Self::path) | where it is plugged in — two meters at once, but it moves with the port |
///
/// [`fingerprint`](Self::fingerprint) combines everything except the port, so
/// it survives the meter being moved.
///
/// # Handling
///
/// These are stable hardware-derived identifiers: the same meter yields the same
/// [`signature`](Self::signature) and [`fingerprint`](Self::fingerprint) across
/// reconnects and reboots, and [`path`](Self::path) carries the host's own device
/// instance for the port it is plugged into. Nothing here is collected, stored or
/// sent anywhere by this crate — it is read out of reports the meter is already
/// streaming. If you put any of it into telemetry, logs or crash reports, hash or
/// truncate it first, and keep `path` on the machine it came from.
#[derive(Clone, PartialEq, Eq)]
pub struct Identity {
    /// USB vendor ID — `0x0716` for every WITRN meter.
    pub vendor_id: u16,
    /// USB product ID — the model, though a revision inherits it.
    pub product_id: u16,
    /// The USB product string, e.g. `"WITRN.K2"`.
    pub product: Option<String>,
    /// The USB serial string. WITRN put a date here, e.g. `"20230727"`.
    pub usb_serial: Option<String>,
    /// The platform-specific HID path this meter was opened on.
    pub path: String,
    /// The meter's own fixed report bytes, from [`signature`].
    pub signature: [u8; SIGNATURE_LEN],
}

impl Identity {
    /// A stable name for the meter, independent of which port it is in.
    ///
    /// ```no_run
    /// # use witrn_hid::WitrnDev;
    /// # let mut dev = WitrnDev::new();
    /// # dev.open()?;
    /// let id = dev.identity(2000)?;
    /// println!("{}", id.fingerprint());   // 0716:5060-20230727-340000200880060020
    /// # Ok::<_, witrn_hid::Error>(())
    /// ```
    pub fn fingerprint(&self) -> String {
        let mut s = format!("{:04X}:{:04X}-", self.vendor_id, self.product_id);
        s.push_str(self.usb_serial.as_deref().unwrap_or("-"));
        s.push('-');
        for b in self.signature {
            s.push_str(&format!("{b:02X}"));
        }
        s
    }
}

impl fmt::Display for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {:04X}:{:04X}",
            self.product.as_deref().unwrap_or("WITRN"),
            self.vendor_id,
            self.product_id
        )?;
        if let Some(s) = &self.usb_serial {
            write!(f, " batch {s}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for Identity {
    /// Abbreviates the two tracking-capable fields.
    ///
    /// `{:?}` is what ends up in a log line or a crash report by accident, and
    /// [`signature`](Self::signature) and [`path`](Self::path) are exactly the parts
    /// that identify one meter and one machine. The fields are public, so anything
    /// that genuinely wants the whole value can still read it — see the type-level
    /// note on handling.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("vendor_id", &format_args!("{:#06X}", self.vendor_id))
            .field("product_id", &format_args!("{:#06X}", self.product_id))
            .field("product", &self.product)
            .field("usb_serial", &self.usb_serial)
            .field("path", &format_args!("{}", abbreviate(&self.path)))
            .field(
                "signature",
                &format_args!(
                    "{:02X}{:02X}…{:02X}{:02X}",
                    self.signature[0],
                    self.signature[1],
                    self.signature[SIGNATURE_LEN - 2],
                    self.signature[SIGNATURE_LEN - 1],
                ),
            )
            .finish()
    }
}

/// Enough of a HID path to tell two ports apart at a glance, without reproducing the
/// host's own device instance identifier.
fn abbreviate(path: &str) -> String {
    const KEEP: usize = 12;
    match path.char_indices().nth(KEEP) {
        Some((cut, _)) => format!("{}… ({} chars)", &path[..cut], path.chars().count()),
        None => path.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(hex: &str) -> Vec<u8> {
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    /// A K2, streaming.
    fn idle() -> Vec<u8> {
        frame(
            "FF5592ACB3B548231A34000050005C29A5409DE89A425A1F00009214000043A0223F\
             A09D0E3F0000C8410000C8C20000000000000000001E200880060020D53A",
        )
    }

    /// A C5 — a revised C4, down to the USB product string — streaming.
    fn c5() -> Vec<u8> {
        frame(
            "FF5597F86DED3C691A3464005000C7DC2D3E27445440BC0000009702000000000000\
             000000000000C841000096C2D2F79F3BE0B4E43800B90008340700203416",
        )
    }

    /// The K2 while it was answering another program: a one-byte reply.
    fn short_reply() -> Vec<u8> {
        frame(
            "FF558777424713980A01500050005C29A5409DE89A425A1F0000870800003666223F\
             D97C0E3F0000C8410000C8C20000000000000000001F2008800600209D23",
        )
    }

    /// ...and a six-byte one.
    fn long_reply() -> Vec<u8> {
        frame(
            "FF5587795C4E59A20A0629FDC8C8F08EA5409DE89A425A1F000087080000D540223F\
             506B0E3F0000C8410000C8C20000000000000000001F2008800600209089",
        )
    }

    #[test]
    fn the_signature_is_the_same_on_every_report_from_one_meter() {
        let sig = signature(&idle()).unwrap().unwrap();
        assert_eq!(sig, [0x34, 0x00, 0x00, 0x20, 0x08, 0x80, 0x06, 0x00, 0x20]);
        // A different report from the same meter, minutes later.
        let later = frame(
            "FF55DD85D3A559CF1A34000050005C29A5409DE89A425A1F0000DD000000465A223F\
             F77F0E3F0000C8410000C8C20000000000000000001E200880060020D53A",
        );
        assert_eq!(signature(&later).unwrap().unwrap(), sig);
    }

    #[test]
    fn two_meters_have_different_signatures() {
        assert_eq!(
            signature(&c5()).unwrap().unwrap(),
            [0x34, 0x64, 0x00, 0x00, 0x08, 0x34, 0x07, 0x00, 0x20]
        );
        assert_ne!(signature(&c5()).unwrap(), signature(&idle()).unwrap());
    }

    /// Byte 12 was once read as the firmware version, two BCD nibbles. These two
    /// meters run V5.0 and V8.3 and both send `0x50`, so it is a marker.
    #[test]
    fn byte_twelve_is_a_fixed_marker_and_not_a_version() {
        assert_eq!(idle()[12], 0x50);
        assert_eq!(c5()[12], 0x50);
    }

    #[test]
    fn a_busy_report_yields_no_signature_rather_than_somebody_elses_payload() {
        assert_eq!(signature(&short_reply()).unwrap(), None);
        assert_eq!(signature(&long_reply()).unwrap(), None);
    }

    #[test]
    fn a_fingerprint_ignores_the_port() {
        let base = Identity {
            vendor_id: 0x0716,
            product_id: 0x5060,
            product: Some("WITRN.K2".into()),
            usb_serial: Some("20230727".into()),
            path: r"\\?\HID#VID_0716&PID_5060#7&2f6e9306&2&0000".into(),
            signature: signature(&idle()).unwrap().unwrap(),
        };
        assert_eq!(base.fingerprint(), "0716:5060-20230727-340000200880060020");

        // The same meter in another port.
        let moved = Identity {
            path: r"\\?\HID#VID_0716&PID_5060#7&1111111&2&0000".into(),
            ..base.clone()
        };
        assert_eq!(moved.fingerprint(), base.fingerprint());

        // A different meter is a different fingerprint.
        let other = Identity {
            product_id: 0x5053,
            usb_serial: Some("20211222".into()),
            signature: signature(&c5()).unwrap().unwrap(),
            ..base.clone()
        };
        assert_ne!(other.fingerprint(), base.fingerprint());
    }

    #[test]
    fn reports_that_are_not_general_reports_are_rejected() {
        let mut pd = vec![0u8; REPORT_LEN];
        pd[0] = 0xFE;
        assert!(matches!(
            signature(&pd),
            Err(Error::UnknownReport { kind: 0xFE })
        ));
        assert!(matches!(
            signature(&[0xFF, 0x55]),
            Err(Error::ShortReport { len: 2 })
        ));
    }

    /// `{:?}` is what reaches a log line or a crash report by accident, and the
    /// signature and path are the two fields that identify a meter and a machine.
    #[test]
    fn debug_output_abbreviates_the_tracking_fields() {
        let path = r"\\?\HID#VID_0716&PID_5060#7&2f6e9306&2&0000";
        let id = Identity {
            vendor_id: 0x0716,
            product_id: 0x5060,
            product: Some("WITRN.K2".into()),
            usb_serial: Some("20230727".into()),
            path: path.into(),
            signature: signature(&idle()).unwrap().unwrap(),
        };

        let debug = format!("{id:?}");
        assert!(!debug.contains(path), "the whole path is in {debug}");
        assert!(
            !debug.contains("340000200880060020"),
            "the whole signature is in {debug}"
        );
        // Still useful: the model is legible and both fields are visibly present.
        assert!(debug.contains("WITRN.K2"), "{debug}");
        assert!(debug.contains("path"), "{debug}");
        assert!(debug.contains("signature"), "{debug}");

        // Anything that genuinely wants the whole value reads the field or the
        // fingerprint, both of which are unchanged.
        assert_eq!(id.path, path);
        assert_eq!(id.fingerprint(), "0716:5060-20230727-340000200880060020");
    }

    #[test]
    fn abbreviating_leaves_a_short_path_alone() {
        assert_eq!(abbreviate("hid0"), "hid0");
        assert!(abbreviate(&"x".repeat(40)).ends_with("(40 chars)"));
    }
}
