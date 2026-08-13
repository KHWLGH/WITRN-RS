//! Start-of-packet ordered sets, the Message Header and the Extended Message Header.

use crate::bits::{flag, num, sl};
use crate::error::Result;
use crate::metadata::{Metadata, Value};

/// The ordered set that framed a PD message, i.e. who it is addressed to.
///
/// Marked `#[non_exhaustive]`: match with a `_` arm so a future ordered set does not
/// break your build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum Sop {
    /// Port-to-port.
    #[default]
    Sop,
    /// To the cable plug nearest the message's source.
    SopPrime,
    /// To the far cable plug.
    SopDoublePrime,
    /// Debug variant of [`SopPrime`](Self::SopPrime).
    SopPrimeDebug,
    /// Debug variant of [`SopDoublePrime`](Self::SopDoublePrime).
    SopDoublePrimeDebug,
    /// Hard Reset — carries no message body.
    HardReset,
    /// Cable Reset — carries no message body.
    CableReset,
}

impl Sop {
    /// The spec's name for this ordered set, as it appears in the parsed tree.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sop => "SOP",
            Self::SopPrime => "SOP'",
            Self::SopDoublePrime => "SOP''",
            Self::SopPrimeDebug => "SOP'_DEBUG",
            Self::SopDoublePrimeDebug => "SOP''_DEBUG",
            Self::HardReset => "Hard_Reset",
            Self::CableReset => "Cable_Reset",
        }
    }

    /// Whether this is a reset rather than a message, so there is nothing to decode.
    pub fn is_reset(self) -> bool {
        matches!(self, Self::HardReset | Self::CableReset)
    }

    /// Whether the plug-facing field layouts apply — true for `SOP'` and `SOP''`.
    fn is_plug(self) -> bool {
        matches!(self, Self::SopPrime | Self::SopDoublePrime)
    }
}

impl std::fmt::Display for Sop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Sop {
    type Err = UnknownSop;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "SOP" => Ok(Self::Sop),
            "SOP'" => Ok(Self::SopPrime),
            "SOP''" => Ok(Self::SopDoublePrime),
            "SOP'_DEBUG" => Ok(Self::SopPrimeDebug),
            "SOP''_DEBUG" => Ok(Self::SopDoublePrimeDebug),
            "Hard_Reset" => Ok(Self::HardReset),
            "Cable_Reset" => Ok(Self::CableReset),
            other => Err(UnknownSop(other.to_owned())),
        }
    }
}

/// Returned by [`Sop`]'s [`FromStr`](std::str::FromStr) for an unrecognised name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownSop(pub String);

impl std::fmt::Display for UnknownSop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown SOP* ordered set: {}", self.0)
    }
}

impl std::error::Error for UnknownSop {}

/// Control Message types — a message with zero data objects.
fn control_message_type(bits: &str) -> &'static str {
    match bits {
        "00001" => "GoodCRC",
        "00010" => "GotoMin",
        "00011" => "Accept",
        "00100" => "Reject",
        "00101" => "Ping",
        "00110" => "PS_RDY",
        "00111" => "Get_Source_Cap",
        "01000" => "Get_Sink_Cap",
        "01001" => "DR_Swap",
        "01010" => "PR_Swap",
        "01011" => "VCONN_Swap",
        "01100" => "Wait",
        "01101" => "Soft_Reset",
        "01110" => "Data_Reset",
        "01111" => "Data_Reset_Complete",
        "10000" => "Not_Supported",
        "10001" => "Get_Source_Cap_Extended",
        "10010" => "Get_Status",
        "10011" => "FR_Swap",
        "10100" => "Get_PPS_Status",
        "10101" => "Get_Country_Codes",
        "10110" => "Get_Sink_Cap_Extended",
        "10111" => "Get_Source_Info",
        "11000" => "Get_Revision",
        _ => "Reserved",
    }
}

/// Data Message types — a message with one or more data objects.
fn data_message_type(bits: &str) -> &'static str {
    match bits {
        "00001" => "Source_Capabilities",
        "00010" => "Request",
        "00011" => "BIST",
        "00100" => "Sink_Capabilities",
        "00101" => "Battery_Status",
        "00110" => "Alert",
        "00111" => "Get_Country_Info",
        "01000" => "Enter_USB",
        "01001" => "EPR_Request",
        "01010" => "EPR_Mode",
        "01011" => "Source_Info",
        "01100" => "Revision",
        "01111" => "Vendor_Defined",
        _ => "Reserved",
    }
}

/// Extended Message types.
fn extended_message_type(bits: &str) -> &'static str {
    match bits {
        "00001" => "Source_Capabilities_Extended",
        "00010" => "Status",
        "00011" => "Get_Battery_Cap",
        "00100" => "Get_Battery_Status",
        "00101" => "Battery_Capabilities",
        "00110" => "Get_Manufacturer_Info",
        "00111" => "Manufacturer_Info",
        "01000" => "Security_Request",
        "01001" => "Security_Response",
        "01010" => "Firmware_Update_Request",
        "01011" => "Firmware_Update_Response",
        "01100" => "PPS_Status",
        "01101" => "Country_Info",
        "01110" => "Country_Codes",
        "01111" => "Sink_Capabilities_Extended",
        "10000" => "Extended_Control",
        "10001" => "EPR_Source_Capabilities",
        "10010" => "EPR_Sink_Capabilities",
        "11110" => "Vendor_Defined_Extended",
        _ => "Reserved",
    }
}

fn spec_revision(bits: &str) -> &'static str {
    match bits {
        "00" => "Rev 1.0",
        "01" => "Rev 2.0",
        "10" => "Rev 3.x",
        _ => "Reserved",
    }
}

/// Decode the 16-bit Message Header.
///
/// Field indices, relied on by message bodies: 0 Extended, 1 Number of Data Objects,
/// 2 MessageID, 3 Port Power Role / Cable Plug, 4 Specification Revision,
/// 5 Port Data Role, 6 Message Type.
pub(crate) fn msg_header(raw: &str, bit_loc: (u32, u32), sop: Sop) -> Result<Metadata> {
    const F: &str = "Message Header";

    let extended = flag(sl(raw, 0, 1), F)?;
    let num_objs = num(sl(raw, 1, 4), F)?;

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 1), (15, 15), "Extended", extended),
        Metadata::new(sl(raw, 1, 4), (14, 12), "Number of Data Objects", num_objs),
        Metadata::new(sl(raw, 4, 7), (11, 9), "MessageID", num(sl(raw, 4, 7), F)?),
    ];

    let role_bit = sl(raw, 7, 8);
    fields.push(match sop {
        Sop::Sop => Metadata::new(
            role_bit,
            (8, 8),
            "Port Power Role",
            if role_bit == "0" { "Sink" } else { "Source" },
        ),
        s if s.is_plug() => Metadata::new(
            role_bit,
            (8, 8),
            "Cable Plug",
            if role_bit == "0" {
                "DFP or UFP"
            } else {
                "Cable Plug or VPD"
            },
        ),
        _ => Metadata::new(
            role_bit,
            (8, 8),
            "Cable Plug",
            if role_bit == "0" {
                "DFP or UFP (D)"
            } else {
                "Cable Plug or VPD (D)"
            },
        ),
    });

    fields.push(Metadata::new(
        sl(raw, 8, 10),
        (7, 6),
        "Specification Revision",
        spec_revision(sl(raw, 8, 10)),
    ));

    fields.push(if sop == Sop::Sop {
        Metadata::new(
            sl(raw, 10, 11),
            (5, 5),
            "Port Data Role",
            if sl(raw, 10, 11) == "0" { "UFP" } else { "DFP" },
        )
    } else {
        Metadata::reserved(sl(raw, 10, 11), (5, 5))
    });

    let type_bits = sl(raw, 11, 16);
    let message_type = if extended {
        extended_message_type(type_bits)
    } else if num_objs == 0 {
        control_message_type(type_bits)
    } else {
        data_message_type(type_bits)
    };
    fields.push(Metadata::new(
        type_bits,
        (4, 0),
        "Message Type",
        message_type,
    ));

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

/// Decode the 16-bit Extended Message Header.
pub(crate) fn ex_msg_header(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "Extended Message Header";

    let fields = vec![
        Metadata::new(sl(raw, 0, 1), (15, 15), "Chunked", flag(sl(raw, 0, 1), F)?),
        Metadata::new(
            sl(raw, 1, 5),
            (14, 11),
            "Chunk Number",
            num(sl(raw, 1, 5), F)?,
        ),
        Metadata::new(
            sl(raw, 5, 6),
            (10, 10),
            "Request Chunk",
            flag(sl(raw, 5, 6), F)?,
        ),
        Metadata::reserved(sl(raw, 6, 7), (9, 9)),
        Metadata::new(sl(raw, 7, 16), (8, 0), "Data Size", num(sl(raw, 7, 16), F)?),
    ];

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

/// Whether an Extended Message Header describes a follow-on chunk that must be
/// appended to a message already in flight.
pub(crate) fn needs_previous_chunk(ex_header: &Metadata) -> bool {
    let chunked = ex_header.get("Chunked").and_then(|m| m.value().as_bool()) == Some(true);
    let later_chunk = ex_header
        .get("Chunk Number")
        .and_then(|m| m.value().as_int())
        .unwrap_or(0)
        > 0;
    let requesting = ex_header
        .get("Request Chunk")
        .and_then(|m| m.value().as_bool())
        == Some(true);
    chunked && later_chunk && !requesting
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::{bits, Order};

    #[test]
    fn sop_names_round_trip() {
        for sop in [
            Sop::Sop,
            Sop::SopPrime,
            Sop::SopDoublePrime,
            Sop::SopPrimeDebug,
            Sop::SopDoublePrimeDebug,
            Sop::HardReset,
            Sop::CableReset,
        ] {
            assert_eq!(sop.as_str().parse::<Sop>().unwrap(), sop);
        }
        assert!("SOP'''".parse::<Sop>().is_err());
    }

    #[test]
    fn decodes_a_source_capabilities_header() {
        // 0x11A1 little-endian => one data object, type 00001, Rev 3.x, Source/DFP.
        let raw = bits(&[0xA1, 0x11], Order::Little);
        let h = msg_header(&raw, (0, 15), Sop::Sop).unwrap();
        assert_eq!(h.get("Extended").unwrap().value().as_bool(), Some(false));
        assert_eq!(
            h.get("Number of Data Objects").unwrap().value().as_int(),
            Some(1)
        );
        assert_eq!(
            h.get("Message Type").unwrap().value().as_str(),
            Some("Source_Capabilities")
        );
        assert_eq!(
            h.get("Specification Revision").unwrap().value().as_str(),
            Some("Rev 3.x")
        );
        assert_eq!(
            h.get("Port Power Role").unwrap().value().as_str(),
            Some("Source")
        );
        assert_eq!(
            h.get("Port Data Role").unwrap().value().as_str(),
            Some("DFP")
        );
    }

    #[test]
    fn zero_data_objects_selects_the_control_message_table() {
        // Type 00011 with no data objects is Accept, not BIST.
        let raw = bits(&[0x03, 0x00], Order::Little);
        let h = msg_header(&raw, (0, 15), Sop::Sop).unwrap();
        assert_eq!(
            h.get("Message Type").unwrap().value().as_str(),
            Some("Accept")
        );
    }

    #[test]
    fn plug_directed_headers_relabel_the_role_bit() {
        let raw = bits(&[0x01, 0x10], Order::Little);
        let h = msg_header(&raw, (0, 15), Sop::SopPrime).unwrap();
        assert!(h.get("Port Power Role").is_none());
        assert!(h.get("Cable Plug").is_some());
        assert!(h.get("Port Data Role").is_none());
    }

    #[test]
    fn truncated_header_is_an_error_not_a_zero() {
        assert!(msg_header("", (0, 15), Sop::Sop).is_err());
    }
}
