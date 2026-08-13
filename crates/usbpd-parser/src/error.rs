//! Errors produced while parsing.

use std::fmt;

/// Everything that can go wrong while turning bytes into a [`Metadata`](crate::Metadata) tree.
///
/// The Python original swallowed every exception inside `pd_msg` and replaced the
/// message body with an `Error Data` node. [`Parser::parse`](crate::Parser::parse)
/// keeps that behaviour; [`Parser::try_parse`](crate::Parser::try_parse) surfaces
/// these instead (the equivalent of the original's `debug=True`).
///
/// Marked `#[non_exhaustive]`: USB-PD keeps growing, so this list will too, and
/// adding a variant should not be a breaking change. Match with a `_` arm.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ParseError {
    /// A bit field was sliced past the end of the message, leaving nothing to decode.
    ///
    /// This is what the original hit as `ValueError: invalid literal for int() with base 2: ''`.
    Truncated {
        /// Name of the field being decoded when the message ran out.
        field: &'static str,
    },
    /// A message body needed a context message that was not supplied.
    ///
    /// `Request`/`EPR_Request` need `last_pdo`, `Status` needs `last_rdo`, and a
    /// non-first chunk of a chunked extended message needs `last_ext`.
    MissingContext {
        /// `"last_pdo"`, `"last_ext"` or `"last_rdo"`.
        which: &'static str,
        /// The message type that asked for it.
        field: &'static str,
    },
    /// An RDO's Object Position does not name a PDO in the stored Source_Capabilities.
    ///
    /// Position is 1-based; `0` and anything past the end of the PDO list land here.
    BadObjectPosition {
        /// The position as encoded in the RDO.
        position: u64,
        /// How many PDOs the context message actually carried.
        available: usize,
    },
    /// A field encodes a combination the spec has not assigned, and there is no
    /// sensible way to keep decoding.
    Unsupported {
        /// What could not be decoded.
        what: &'static str,
    },
    /// A field that must hold text did not contain valid ASCII.
    NotAscii {
        /// Name of the field being decoded.
        field: &'static str,
    },
    /// The CRC32 trailer did not match the payload.
    CrcMismatch {
        /// CRC computed over the payload.
        expected: u32,
        /// CRC carried by the message.
        received: u32,
    },
    /// A hex string handed to [`hex_to_bytes`](crate::hex_to_bytes) was malformed.
    BadHex(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated { field } => write!(f, "message truncated while decoding `{field}`"),
            Self::MissingContext { which, field } => {
                write!(f, "`{field}` needs a `{which}` context message")
            }
            Self::BadObjectPosition {
                position,
                available,
            } => write!(
                f,
                "RDO object position {position} is out of range (context has {available} PDO(s))"
            ),
            Self::Unsupported { what } => write!(f, "unsupported encoding in `{what}`"),
            Self::NotAscii { field } => write!(f, "`{field}` is not valid ASCII"),
            Self::CrcMismatch { expected, received } => write!(
                f,
                "CRC check failed (expected 0x{expected:08X}, got 0x{received:08X})"
            ),
            Self::BadHex(s) => write!(f, "not a hex string: {s}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Shorthand for parse results.
pub type Result<T> = std::result::Result<T, ParseError>;
