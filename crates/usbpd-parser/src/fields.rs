//! Field names, as one definition rather than a literal at every lookup.
//!
//! [`Metadata::get`](crate::Metadata::get) takes a name, so every consumer of a
//! parsed tree — including ones in other crates — has to spell that name out. Doing
//! it with a literal each time means a rename compiles cleanly everywhere and simply
//! stops matching at run time. That is not hypothetical here: the Python original
//! looked only for `"Data Objects"`, and an EPR capabilities message names its block
//! `"Data Block"`, so a `Request` that followed one silently failed to decode.
//!
//! These constants cover the names that are looked up outside the module that
//! produces them. Names used only within a single decoder stay inline.
//!
//! ```
//! use usbpd_parser::{fields, ParseOptions, Parser};
//!
//! let msg = Parser::new().parse(&[0x41, 0x00], ParseOptions::default());
//! let header = msg.get(fields::MESSAGE_HEADER).unwrap();
//! assert_eq!(
//!     header.get(fields::MESSAGE_TYPE).unwrap().value().as_str(),
//!     Some("GoodCRC")
//! );
//! ```

/// The root node of a decoded message.
pub const PD: &str = "PD";
/// The synthetic node naming the ordered set that framed the message.
pub const SOP: &str = "SOP*";
/// The 16-bit Message Header.
pub const MESSAGE_HEADER: &str = "Message Header";
/// The decoded message type, e.g. `"Source_Capabilities"`.
pub const MESSAGE_TYPE: &str = "Message Type";
/// The 16-bit Extended Message Header, present only on extended messages.
pub const EXTENDED_MESSAGE_HEADER: &str = "Extended Message Header";
/// Whether an extended message is chunked.
pub const CHUNKED: &str = "Chunked";
/// Which chunk of a chunked extended message this is.
pub const CHUNK_NUMBER: &str = "Chunk Number";
/// Whether an extended message is asking for the next chunk rather than carrying one.
pub const REQUEST_CHUNK: &str = "Request Chunk";
/// Total length of an extended message's data block.
pub const DATA_SIZE: &str = "Data Size";
/// The data-object block of a non-extended message.
pub const DATA_OBJECTS: &str = "Data Objects";
/// The data block of an extended message — what an EPR message calls its objects.
pub const DATA_BLOCK: &str = "Data Block";
/// The node carrying the raw bytes of a message that could not be decoded.
pub const ERROR_DATA: &str = "Error Data";
/// The Request Data Object inside a `Request`.
pub const RDO: &str = "RDO";
/// A PDO's supply type, which also selects the layout of an RDO requesting it.
pub const SUPPLY_TYPE: &str = "Supply Type";
/// An augmented PDO's sub-type.
pub const APDO_TYPE: &str = "APDO Type";
/// The vendor ID inside an ID Header VDO.
pub const USB_VENDOR_ID: &str = "USB Vendor ID";
/// The vendor ID of an extended capabilities block or unstructured VDM header.
pub const VID: &str = "VID";
/// Bits that carry no value at this revision. Never resolves through
/// [`Metadata::get`](crate::Metadata::get) — a node usually has several.
pub const RESERVED: &str = "Reserved";
