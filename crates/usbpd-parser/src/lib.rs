//! Parse USB Power Delivery messages into an inspectable field tree.
//!
//! A Rust port of the [`usbpdparser`](https://pypi.org/project/usbpdparser/) Python
//! package. Feed it the bytes of a PD message and it hands back a [`Metadata`] tree:
//! every field named, positioned in bits, and decoded to a value — Message Header,
//! PDOs, RDOs, VDOs, and every extended message body including the chunked ones.
//!
//! # Getting started
//!
//! ```
//! use usbpd_parser::{ParseOptions, Parser, Sop};
//!
//! let mut parser = Parser::new();
//!
//! // A Source advertising 5 V / 3 A.
//! let msg = parser.parse(
//!     &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
//!     ParseOptions { sop: Sop::Sop, ..Default::default() },
//! );
//!
//! let pdo = msg.get("Data Objects").unwrap().get("PDO 1").unwrap();
//! assert_eq!(pdo.quick_pdo(), Some("F 5.0V@3.0A"));
//! assert_eq!(pdo.get("Voltage").unwrap().value().as_str(), Some("5.0V"));
//! ```
//!
//! # The data model
//!
//! Everything is a [`Metadata`]: `raw` (the bits, as a string of `'0'`/`'1'`),
//! `bit_loc` (where they sit in the parent), `field` (the name), and `value` — either
//! a decoded leaf or the list of sub-fields one level down. Walk it with
//! [`get`](Metadata::get) by name or [`at`](Metadata::at) by index.
//!
//! A single logical field is stored little-endian on the wire but indexed MSB-first,
//! while a container spanning several fields keeps wire order. `0x14A5` therefore
//! reads as `1010010100010100` in a leaf and `0001010010100101` in its parent.
//!
//! # Conversation state
//!
//! Some messages are only decodable in context. A `Request` names an object position
//! within the `Source_Capabilities` that preceded it; a later chunk of an extended
//! message continues an earlier one; a `Status` message's CL/CV flag depends on the
//! `Request` in force. [`Parser`] tracks all three for a stream. If you keep your own
//! message history instead, pass them explicitly through [`ParseOptions`] — doing so
//! leaves the parser's own state untouched.
//!
//! ```
//! use usbpd_parser::{is_pdo, is_rdo, provides_ext, ParseOptions, Parser};
//!
//! let mut parser = Parser::new();
//! let msg = parser.parse(&[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08], ParseOptions::default());
//!
//! // The same classifiers the parser uses internally, for your own history.
//! assert!(is_pdo(&msg));
//! assert!(!is_rdo(&msg));
//! assert!(!provides_ext(&msg));
//! ```
//!
//! # Malformed input
//!
//! [`Parser::parse`] never fails: a message it cannot decode still yields a tree,
//! with the bytes under an `Error Data` node. [`Parser::try_parse`] reports the
//! [`ParseError`] instead.
//!
//! # Features
//!
//! - `serde` *(default)* — `Serialize` for [`Metadata`] and friends.
//! - `vendor-ids` *(default)* — the USB-IF vendor table behind [`vendor_name`].

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod bits;
mod context;
mod crc;
mod data_msg;
mod error;
mod ext_msg;
pub mod fields;
mod header;
mod metadata;
mod parser;
mod pdo;
mod rdo;
mod render;
mod vdo;
mod vendor_ids;

pub use bits::{bits_to_hex, hex_to_bytes, py_float, Order};
pub use crc::{crc32, verify_crc};
pub use error::{ParseError, Result};
pub use header::{Sop, UnknownSop};
pub use metadata::{BitLoc, Metadata, Raw, SupplyType, Value};
pub use parser::{is_pdo, is_rdo, provides_ext, ParseOptions, Parser};
pub use render::{render, render_all, to_ansi, to_plain, ColorToken, Style, MAX_RENDER_DEPTH};
pub use vendor_ids::vendor_name;

/// The version of the Python package this port tracks.
pub const UPSTREAM_VERSION: &str = "1.1.6";
