//! Errors from talking to a WITRN meter.

use std::fmt;

/// Everything that can go wrong reading or unpacking a WITRN HID report.
///
/// Marked `#[non_exhaustive]`: match with a `_` arm so a future failure mode does not
/// break your build.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The underlying HID transport failed.
    Hid(hidapi::HidError),
    /// The USB-PD payload was malformed or missing required conversation context.
    Pd(usbpd_parser::ParseError),
    /// A read or unpack was attempted before [`WitrnDev::open`](crate::WitrnDev::open).
    NotOpen,
    /// An unpack was attempted before any report had been read.
    NoData,
    /// A report shorter than the 64 bytes every WITRN report occupies.
    ShortReport {
        /// How many bytes actually arrived.
        len: usize,
    },
    /// A report had extra bytes instead of the protocol's exact 64-byte size.
    InvalidReportLength {
        /// How many bytes actually arrived.
        len: usize,
    },
    /// A report whose leading byte is neither `0xFF` (general) nor `0xFE` (PD).
    UnknownReport {
        /// The leading byte.
        kind: u8,
    },
    /// A PD report framed by an ordered set this crate does not recognise.
    ///
    /// The ordered set selects the Message Header's role fields and the Discover
    /// Identity product-type tables, so decoding one that cannot be identified would
    /// produce a plausible tree with the wrong fields in it.
    UnknownOrderedSet {
        /// Byte 2 of the report, which names the ordered set.
        byte: u8,
    },
    /// A general report contains a value outside the meter's supported range.
    InvalidMeasurement {
        /// The field or group of fields that failed validation.
        field: &'static str,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hid(e) => write!(f, "HID error: {e}"),
            Self::Pd(e) => write!(f, "USB-PD parse error: {e}"),
            Self::NotOpen => f.write_str("no device is open"),
            Self::NoData => f.write_str("no report has been read yet"),
            Self::ShortReport { len } => {
                write!(f, "report is {len} bytes, expected at least 64")
            }
            Self::InvalidReportLength { len } => {
                write!(f, "report is {len} bytes, expected exactly 64")
            }
            Self::UnknownReport { kind } => {
                write!(f, "unknown report type 0x{kind:02X}, expected 0xFF or 0xFE")
            }
            Self::UnknownOrderedSet { byte } => {
                write!(
                    f,
                    "unknown ordered set 0x{byte:02X} in byte 2 of a PD report"
                )
            }
            Self::InvalidMeasurement { field } => {
                write!(f, "invalid measurement in {field}")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Hid(e) => Some(e),
            Self::Pd(e) => Some(e),
            _ => None,
        }
    }
}

impl From<hidapi::HidError> for Error {
    fn from(e: hidapi::HidError) -> Self {
        Self::Hid(e)
    }
}

impl From<usbpd_parser::ParseError> for Error {
    fn from(e: usbpd_parser::ParseError) -> Self {
        Self::Pd(e)
    }
}

/// Shorthand for results from this crate.
pub type Result<T> = std::result::Result<T, Error>;
