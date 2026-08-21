//! Parser entry point: turn PD message bytes into a [`Metadata`] tree, carrying the
//! conversation state that later messages need.

use crate::bits::{bits, bsl, hex_upper, Order};
use crate::context::Ctx;
use crate::crc::verify_crc;
use crate::data_msg;
use crate::error::{ParseError, Result};
use crate::ext_msg;
use crate::fields;
use crate::header::{ex_msg_header, msg_header, Sop};
use crate::metadata::{BitLoc, Metadata, Raw, Value};

/// How to parse one message.
///
/// ```
/// use usbpd_parser::{ParseOptions, Sop};
///
/// // A WITRN capture: proprietary PPS layout, CRC already stripped by the meter.
/// let opts = ParseOptions { sop: Sop::Sop, prop_protocol: true, ..Default::default() };
/// # let _ = opts;
/// ```
#[derive(Debug, Default)]
pub struct ParseOptions<'a> {
    /// Which ordered set framed the message. Defaults to [`Sop::Sop`].
    pub sop: Sop,
    /// Check the trailing 4-byte CRC32 before decoding.
    pub verify_crc: bool,
    /// Decode PPS objects with WITRN's proprietary widened fields instead of the
    /// spec layout.
    pub prop_protocol: bool,
    /// Source_Capabilities to resolve a Request against. Overrides the parser's own
    /// state, and suppresses updating it.
    pub last_pdo: Option<&'a Metadata>,
    /// Earlier chunks of a chunked extended message.
    pub last_ext: Option<&'a Metadata>,
    /// The Request in force, which a Status message's CL/CV flag depends on.
    pub last_rdo: Option<&'a Metadata>,
}

impl ParseOptions<'_> {
    /// Whether the caller supplied conversation state of their own.
    fn has_context(&self) -> bool {
        self.last_pdo.is_some() || self.last_ext.is_some() || self.last_rdo.is_some()
    }
}

/// A stateful PD message parser.
///
/// Some messages are only decodable in context — a Request names a PDO from the
/// Source_Capabilities that preceded it, a later chunk of an extended message
/// continues an earlier one. Feed a stream through one `Parser` and it keeps that
/// state for you; pass state explicitly through [`ParseOptions`] if you maintain
/// your own history instead.
///
/// ```
/// use usbpd_parser::{Parser, ParseOptions, Sop};
///
/// let mut parser = Parser::new();
/// let opts = || ParseOptions { sop: Sop::Sop, ..Default::default() };
///
/// // Source advertises 5V/3A and 9V/3A...
/// parser.parse(&[0xA1, 0x21, 0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00], opts());
/// // ...and the Sink asks for the second one.
/// let request = parser.parse(&[0x42, 0x10, 0x2C, 0xB1, 0x04, 0x20], opts());
///
/// let rdo = request.get("Data Objects").unwrap().get("RDO").unwrap();
/// assert_eq!(rdo.quick_rdo(), Some("[2] F 9.0V@3.0A"));
/// ```
#[derive(Debug, Default, Clone)]
pub struct Parser {
    last_pdo: Option<Metadata>,
    last_ext: Option<Metadata>,
    last_rdo: Option<Metadata>,
}

impl Parser {
    /// A parser with no conversation state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse a message, falling back to an `Error Data` node if it cannot be decoded.
    ///
    /// This never fails — malformed messages still produce a tree, with the raw bytes
    /// under `Error Data`. Use [`try_parse`](Self::try_parse) to see why instead.
    pub fn parse(&mut self, data: &[u8], opts: ParseOptions<'_>) -> Metadata {
        let sop = opts.sop;
        self.try_parse(data, opts).unwrap_or_else(|err| match err {
            ParseError::CrcMismatch { .. } => Metadata::new(
                bits(data, Order::Big),
                span(data),
                "System",
                "CRC Check Failed",
            ),
            _ => error_message(data, sop),
        })
    }

    /// Parse a message, reporting why it could not be decoded.
    pub fn try_parse(&mut self, data: &[u8], opts: ParseOptions<'_>) -> Result<Metadata> {
        if opts.verify_crc && !verify_crc(data) {
            let payload = bsl(data, 0, data.len().saturating_sub(4));
            let received = bsl(data, data.len().saturating_sub(4), data.len());
            return Err(ParseError::CrcMismatch {
                expected: crate::crc::crc32(payload),
                received: u32::from_le_bytes(<[u8; 4]>::try_from(received).unwrap_or_default()),
            });
        }

        if opts.sop.is_reset() {
            if !opts.has_context() {
                self.last_pdo = None;
                self.last_ext = None;
                self.last_rdo = None;
            }
            return Ok(Metadata::new(
                Raw::Text(opts.sop.as_str().into()),
                BitLoc::None,
                "PD",
                opts.sop.as_str(),
            ));
        }

        let caller_owns_state = opts.has_context();
        let msg = {
            let (last_pdo, last_ext, last_rdo) = if caller_owns_state {
                (opts.last_pdo, opts.last_ext, opts.last_rdo)
            } else {
                (
                    self.last_pdo.as_ref(),
                    self.last_ext.as_ref(),
                    self.last_rdo.as_ref(),
                )
            };
            decode(
                data,
                opts.sop,
                last_pdo,
                last_ext,
                last_rdo,
                opts.prop_protocol,
            )?
        };

        // Explicitly supplied context must not disturb the parser's own history.
        if !caller_owns_state {
            if is_pdo(&msg) {
                self.last_pdo = Some(msg.clone());
            }
            if provides_ext(&msg) {
                self.last_ext = Some(msg.clone());
            }
            if is_rdo(&msg) {
                self.last_rdo = Some(msg.clone());
            }
        }

        Ok(msg)
    }

    /// Forget the conversation state, e.g. after a Hard Reset or a reconnect.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// The most recent Source_Capabilities on record.
    pub fn last_pdo(&self) -> Option<&Metadata> {
        self.last_pdo.as_ref()
    }

    /// The most recent chunked extended message awaiting continuation.
    pub fn last_ext(&self) -> Option<&Metadata> {
        self.last_ext.as_ref()
    }

    /// The most recent Request on record.
    pub fn last_rdo(&self) -> Option<&Metadata> {
        self.last_rdo.as_ref()
    }
}

/// Bit span of a whole buffer.
fn span(data: &[u8]) -> (u32, u32) {
    (0, (data.len() as u32 * 8).saturating_sub(1))
}

/// The tree a message that could not be decoded still produces.
fn error_message(data: &[u8], sop: Sop) -> Metadata {
    Metadata::new(
        bits(data, Order::Big),
        span(data),
        fields::PD,
        Value::List(vec![
            sop_node(sop),
            Metadata::new(
                bits(data, Order::Big),
                span(data),
                fields::ERROR_DATA,
                format!("0x{}", hex_upper(data)),
            ),
        ]),
    )
}

fn sop_node(sop: Sop) -> Metadata {
    Metadata::new(
        Raw::Text(sop.as_str().into()),
        BitLoc::None,
        fields::SOP,
        sop.as_str(),
    )
}

/// Decode one message: SOP label, Message Header, optional Extended Message Header,
/// and the body.
fn decode(
    data: &[u8],
    sop: Sop,
    last_pdo: Option<&Metadata>,
    last_ext: Option<&Metadata>,
    last_rdo: Option<&Metadata>,
    prop_protocol: bool,
) -> Result<Metadata> {
    let header = msg_header(&bits(bsl(data, 0, 2), Order::Little), (0, 15), sop)?;

    let extended = header
        .at(0)
        .and_then(|m| m.value().as_bool())
        .unwrap_or(false);
    let num_objs = header
        .at(1)
        .and_then(|m| m.value().as_int())
        .unwrap_or(0)
        .max(0) as usize;
    let message_type = header
        .get("Message Type")
        .and_then(|m| m.value().as_str())
        .unwrap_or("Reserved")
        .to_owned();

    // Number of Data Objects counts 32-bit words after the 16-bit Message Header.
    // Unchunked extended messages set NDO=0; length is Extended Header Data Size.
    let mut end = 2 + num_objs * 4;

    let mut body = None;
    let ex_header = if extended {
        Some(ex_msg_header(
            &bits(bsl(data, 2, 4), Order::Little),
            (16, 31),
        )?)
    } else {
        None
    };

    if let Some(ex) = ex_header.as_ref() {
        let chunked = ex.get("Chunked").and_then(|m| m.value().as_bool()) == Some(true);
        if !chunked {
            let size = ex
                .get("Data Size")
                .and_then(|m| m.value().as_int())
                .unwrap_or(0)
                .max(0) as usize;
            end = 4 + size;
        }
    }
    end = end.min(data.len());

    {
        let ctx = Ctx {
            sop,
            header: &header,
            ex_header: ex_header.as_ref(),
            last_pdo,
            last_ext,
            last_rdo,
            prop_protocol,
        };

        if extended {
            // The Extended Message Header eats the first 2 bytes of the object area.
            body = Some(ext_msg::parse(
                &message_type,
                bsl(data, 4, end),
                (32, (end as u32 * 8).saturating_sub(1)),
                &ctx,
            )?);
        } else if let Some(parsed) = data_msg::parse(
            &message_type,
            bsl(data, 2, end),
            (16, (end as u32 * 8).saturating_sub(1)),
            &ctx,
        ) {
            body = Some(parsed?);
        }
    }

    let mut fields = vec![sop_node(sop), header];
    fields.extend(ex_header);
    fields.extend(body);

    Ok(Metadata::new(
        bits(data, Order::Big),
        span(data),
        "PD",
        Value::List(fields),
    ))
}

/// Whether `msg` advertises Source capabilities, and so should become the `last_pdo`
/// a later Request resolves against.
pub fn is_pdo(msg: &Metadata) -> bool {
    matches!(
        message_type_of(msg),
        Some("Source_Capabilities" | "EPR_Source_Capabilities")
    )
}

/// Whether `msg` is a Request, and so should become the `last_rdo` a later Status
/// message resolves against.
pub fn is_rdo(msg: &Metadata) -> bool {
    matches!(message_type_of(msg), Some("Request" | "EPR_Request"))
}

/// Whether `msg` is a chunk that a following chunk must be appended to.
///
/// A chunk *request* carries no payload, so it provides no context.
pub fn provides_ext(msg: &Metadata) -> bool {
    let Some(ex_header) = msg.get(fields::EXTENDED_MESSAGE_HEADER) else {
        return false;
    };
    let chunked = ex_header
        .get(fields::CHUNKED)
        .and_then(|m| m.value().as_bool())
        == Some(true);
    let requesting = ex_header
        .get(fields::REQUEST_CHUNK)
        .and_then(|m| m.value().as_bool())
        == Some(true);
    chunked && !requesting
}

fn message_type_of(msg: &Metadata) -> Option<&str> {
    msg.message_type()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts<'a>() -> ParseOptions<'a> {
        ParseOptions {
            sop: Sop::Sop,
            ..Default::default()
        }
    }

    /// Source_Capabilities: 5V/3A.
    const CAPS: &[u8] = &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08];
    /// Request: object position 1, 3.0 A.
    const REQUEST: &[u8] = &[0x42, 0x10, 0x2C, 0xB1, 0x04, 0x10];

    #[test]
    fn decodes_a_whole_source_capabilities_message() {
        let msg = Parser::new().parse(CAPS, opts());
        assert_eq!(msg.field(), "PD");
        assert_eq!(msg.get("SOP*").unwrap().value().as_str(), Some("SOP"));
        assert_eq!(
            msg.get("Message Header")
                .unwrap()
                .get("Message Type")
                .unwrap()
                .value()
                .as_str(),
            Some("Source_Capabilities")
        );
        assert_eq!(
            msg.get("Data Objects")
                .unwrap()
                .get("PDO 1")
                .unwrap()
                .quick_pdo(),
            Some("F 5.0V@3.0A")
        );
    }

    #[test]
    fn a_control_message_has_only_a_header() {
        let msg = Parser::new().parse(&[0x41, 0x00], opts());
        assert_eq!(msg.children().unwrap().len(), 2);
        assert_eq!(
            msg.get("Message Header")
                .unwrap()
                .get("Message Type")
                .unwrap()
                .value()
                .as_str(),
            Some("GoodCRC")
        );
    }

    #[test]
    fn conversation_state_carries_across_messages() {
        let mut parser = Parser::new();
        parser.parse(CAPS, opts());
        assert!(parser.last_pdo().is_some());

        let request = parser.parse(REQUEST, opts());
        assert_eq!(
            request
                .get("Data Objects")
                .unwrap()
                .get("RDO")
                .unwrap()
                .quick_rdo(),
            Some("[1] F 5.0V@3.0A")
        );
        assert!(parser.last_rdo().is_some());
    }

    #[test]
    fn explicit_context_does_not_disturb_the_parsers_own_state() {
        let mut owner = Parser::new();
        let caps = owner.parse(CAPS, opts());

        let mut parser = Parser::new();
        parser.parse(
            REQUEST,
            ParseOptions {
                sop: Sop::Sop,
                last_pdo: Some(&caps),
                ..Default::default()
            },
        );
        assert!(
            parser.last_rdo().is_none(),
            "caller-supplied context must stay caller-owned"
        );
    }

    #[test]
    fn resetting_forgets_the_conversation() {
        let mut parser = Parser::new();
        parser.parse(CAPS, opts());
        parser.reset();
        assert!(parser.last_pdo().is_none());
    }

    #[test]
    fn an_undecodable_message_still_produces_a_tree() {
        // Claims four data objects but carries none.
        let msg = Parser::new().parse(&[0x81, 0x10], opts());
        assert_eq!(
            msg.get("Error Data").unwrap().value().as_str(),
            Some("0x8110")
        );
        assert_eq!(msg.get("SOP*").unwrap().value().as_str(), Some("SOP"));
    }

    #[test]
    fn try_parse_reports_the_reason_instead() {
        assert!(Parser::new().try_parse(&[0x81, 0x10], opts()).is_err());
    }

    #[test]
    fn a_reset_carries_no_body() {
        let msg = Parser::new().parse(
            &[],
            ParseOptions {
                sop: Sop::HardReset,
                ..Default::default()
            },
        );
        assert_eq!(msg.field(), "PD");
        assert_eq!(msg.value().as_str(), Some("Hard_Reset"));
    }

    #[test]
    fn a_hard_reset_forgets_source_capabilities() {
        let mut parser = Parser::new();
        parser.parse(&CAPS, opts());
        assert!(parser.last_pdo().is_some());
        parser.parse(
            &[],
            ParseOptions {
                sop: Sop::HardReset,
                ..Default::default()
            },
        );
        assert!(parser.last_pdo().is_none());
        assert!(parser.last_rdo().is_none());
    }

    #[test]
    fn crc_verification_is_opt_in_and_reported() {
        let mut framed = CAPS.to_vec();
        framed.extend_from_slice(&crate::crc::crc32(CAPS).to_le_bytes());

        let good = Parser::new().parse(
            &framed,
            ParseOptions {
                verify_crc: true,
                ..Default::default()
            },
        );
        assert_eq!(good.field(), "PD");

        framed[3] ^= 0xFF;
        let bad = Parser::new().parse(
            &framed,
            ParseOptions {
                verify_crc: true,
                ..Default::default()
            },
        );
        assert_eq!(bad.field(), "System");
        assert_eq!(bad.value().as_str(), Some("CRC Check Failed"));
    }

    #[test]
    fn classifiers_agree_with_the_message_type() {
        let mut parser = Parser::new();
        let caps = parser.parse(CAPS, opts());
        assert!(is_pdo(&caps));
        assert!(!is_rdo(&caps));
        assert!(!provides_ext(&caps));

        let request = parser.parse(REQUEST, opts());
        assert!(is_rdo(&request));
        assert!(!is_pdo(&request));
    }
}
