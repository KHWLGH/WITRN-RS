//! PD status block and event stream (attribute 0x0010), plus the numeric PDO decode the
//! trigger needs. Full message decoding for display is left to `usbpd-parser`.

use super::{read_i16, read_u16, read_u32, ProtocolError, Result};

pub const PD_STATUS_SIZE: usize = 12;
pub const PD_EVENT_HEADER_SIZE: usize = 6;
pub const PD_EVENT_CONNECTION: u8 = 0x45;
pub const PD_CONNECT: u8 = 0x21;
pub const PD_DISCONNECT: u8 = 0x22;
pub const PD_CONNECT_LEGACY: u8 = 0x11;
pub const PD_DISCONNECT_LEGACY: u8 = 0x12;
const PD_EVENT_SIZE_MASK: u8 = 0x3F;
const PD_EVENT_SIZE_OFFSET: u8 = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdStatus {
    pub timestamp_ms: u32,
    pub vbus_mv: u16,
    pub ibus_ma: i16,
    pub cc1_mv: u16,
    pub cc2_mv: u16,
}

impl PdStatus {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < PD_STATUS_SIZE {
            return Err(ProtocolError::TooShort {
                need: PD_STATUS_SIZE,
                got: bytes.len(),
            });
        }
        Ok(Self {
            timestamp_ms: read_u32(bytes, 0)?,
            vbus_mv: read_u16(bytes, 4)?,
            ibus_ma: read_i16(bytes, 6)?,
            cc1_mv: read_u16(bytes, 8)?,
            cc2_mv: read_u16(bytes, 10)?,
        })
    }

    pub fn vbus_v(&self) -> f64 {
        f64::from(self.vbus_mv) / 1000.0
    }

    pub fn ibus_a(&self) -> f64 {
        f64::from(self.ibus_ma) / 1000.0
    }

    pub fn cc1_v(&self) -> f64 {
        f64::from(self.cc1_mv) / 1000.0
    }

    pub fn cc2_v(&self) -> f64 {
        f64::from(self.cc2_mv) / 1000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum Sop {
    Sop,
    SopPrime,
    SopDoublePrime,
    Unknown(u8),
}

impl Sop {
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Sop,
            1 => Self::SopPrime,
            2 => Self::SopDoublePrime,
            other => Self::Unknown(other),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PdEventKind {
    Connect,
    Disconnect,
    Message(PdMessage),
    Unknown { code: u8 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdEvent {
    /// Meter clock, not host time.
    pub timestamp_ms: u32,
    pub kind: PdEventKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPdPayload {
    pub status: PdStatus,
    pub events: Vec<PdEvent>,
}

pub fn parse_pd_payload(bytes: &[u8]) -> Result<ParsedPdPayload> {
    let status = PdStatus::parse(bytes)?;
    if bytes.len() == PD_STATUS_SIZE {
        return Ok(ParsedPdPayload {
            status,
            events: Vec::new(),
        });
    }
    let events = parse_pd_events(&bytes[PD_STATUS_SIZE..])?;
    Ok(ParsedPdPayload { status, events })
}

pub fn parse_pd_events(bytes: &[u8]) -> Result<Vec<PdEvent>> {
    Ok(parse_pd_events_lossy(bytes))
}

/// Walk the event records. A truncated tail or zero padding ends the stream; an
/// undecodable size byte is skipped one byte at a time to resynchronise.
fn parse_pd_events_lossy(bytes: &[u8]) -> Vec<PdEvent> {
    let mut events = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        if bytes.len() - offset < PD_EVENT_HEADER_SIZE {
            break;
        }
        let size_flag = bytes[offset];
        if size_flag == 0 {
            break;
        }
        if size_flag == PD_EVENT_CONNECTION {
            let ts24 =
                u32::from_le_bytes([bytes[offset + 1], bytes[offset + 2], bytes[offset + 3], 0]);
            let code = bytes[offset + 5];
            let kind = match code {
                PD_CONNECT | PD_CONNECT_LEGACY => PdEventKind::Connect,
                PD_DISCONNECT | PD_DISCONNECT_LEGACY => PdEventKind::Disconnect,
                _ => PdEventKind::Unknown { code },
            };
            events.push(PdEvent {
                timestamp_ms: ts24,
                kind,
            });
            offset += PD_EVENT_HEADER_SIZE;
            continue;
        }

        let encoded = size_flag & PD_EVENT_SIZE_MASK;
        let Some(wire_len) = encoded.checked_sub(PD_EVENT_SIZE_OFFSET) else {
            offset += 1;
            continue;
        };
        let wire_len = wire_len as usize;
        let timestamp = u32::from_le_bytes([
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
            bytes[offset + 4],
        ]);
        let sop = bytes[offset + 5];
        let body_at = offset + PD_EVENT_HEADER_SIZE;
        if bytes.len() - body_at < wire_len {
            break;
        }
        let wire = bytes[body_at..body_at + wire_len].to_vec();
        offset = body_at + wire_len;
        events.push(PdEvent {
            timestamp_ms: timestamp,
            kind: PdEventKind::Message(PdMessage::parse(Sop::from_u8(sop), wire)),
        });
    }
    events
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdHeader {
    pub raw: u16,
    pub message_type: u8,
    pub num_objects: u8,
    pub extended: bool,
}

impl PdHeader {
    pub fn parse(raw: u16) -> Self {
        Self {
            raw,
            message_type: (raw & 0x1F) as u8,
            num_objects: ((raw >> 12) & 0x7) as u8,
            extended: ((raw >> 15) & 1) == 1,
        }
    }

    pub fn is_data(&self) -> bool {
        self.num_objects > 0
    }

    pub fn type_name(&self) -> &'static str {
        if self.extended {
            return "Extended";
        }
        if self.is_data() {
            match self.message_type {
                0x01 => "Source_Capabilities",
                0x02 => "Request",
                0x04 => "Sink_Capabilities",
                0x09 => "EPR_Request",
                0x0F => "Vendor_Defined",
                _ => "Data",
            }
        } else {
            match self.message_type {
                0x01 => "GoodCRC",
                0x03 => "Accept",
                0x04 => "Reject",
                0x06 => "PS_RDY",
                _ => "Control",
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Pdo {
    Fixed {
        voltage_mv: u32,
        max_current_ma: u32,
        dual_role_power: bool,
        unconstrained_power: bool,
        usb_comm: bool,
        dual_role_data: bool,
    },
    Battery {
        min_voltage_mv: u32,
        max_voltage_mv: u32,
        max_power_mw: u32,
    },
    Variable {
        min_voltage_mv: u32,
        max_voltage_mv: u32,
        max_current_ma: u32,
    },
    Pps {
        min_voltage_mv: u32,
        max_voltage_mv: u32,
        max_current_ma: u32,
    },
    Avs {
        min_voltage_mv: u32,
        max_voltage_mv: u32,
        pdp_w: u32,
        epr: bool,
        max_current_9v_15v_ma: Option<u32>,
        max_current_15v_20v_ma: Option<u32>,
    },
    Unknown(u32),
}

impl Pdo {
    pub fn parse(raw: u32) -> Self {
        match raw >> 30 {
            0 => Self::Fixed {
                voltage_mv: ((raw >> 10) & 0x3FF) * 50,
                max_current_ma: (raw & 0x3FF) * 10,
                dual_role_power: ((raw >> 29) & 1) == 1,
                unconstrained_power: ((raw >> 27) & 1) == 1,
                usb_comm: ((raw >> 26) & 1) == 1,
                dual_role_data: ((raw >> 25) & 1) == 1,
            },
            1 => Self::Battery {
                max_voltage_mv: ((raw >> 20) & 0x3FF) * 50,
                min_voltage_mv: ((raw >> 10) & 0x3FF) * 50,
                max_power_mw: (raw & 0x3FF) * 250,
            },
            2 => Self::Variable {
                max_voltage_mv: ((raw >> 20) & 0x3FF) * 50,
                min_voltage_mv: ((raw >> 10) & 0x3FF) * 50,
                max_current_ma: (raw & 0x3FF) * 10,
            },
            3 => match (raw >> 28) & 0x3 {
                0 => Self::Pps {
                    max_voltage_mv: ((raw >> 17) & 0xFF) * 100,
                    min_voltage_mv: ((raw >> 8) & 0xFF) * 100,
                    max_current_ma: (raw & 0x7F) * 50,
                },
                // USB PD: APDO subtype 1 = EPR AVS, 2 = SPR AVS (9–20 V dual current).
                1 => Self::epr_avs(raw),
                2 => Self::spr_avs(raw),
                _ => Self::Unknown(raw),
            },
            _ => Self::Unknown(raw),
        }
    }

    fn epr_avs(raw: u32) -> Self {
        Self::Avs {
            max_voltage_mv: ((raw >> 17) & 0x1FF) * 100,
            min_voltage_mv: ((raw >> 8) & 0xFF) * 100,
            pdp_w: raw & 0xFF,
            epr: true,
            max_current_9v_15v_ma: None,
            max_current_15v_20v_ma: None,
        }
    }

    fn spr_avs(raw: u32) -> Self {
        let i_9_15 = ((raw >> 10) & 0x3FF) * 10;
        let i_15_20 = (raw & 0x3FF) * 10;
        if i_9_15 == 0 && i_15_20 == 0 {
            return Self::Unknown(raw);
        }
        let min_voltage_mv = if i_9_15 > 0 { 9000 } else { 15000 };
        let max_voltage_mv = if i_15_20 > 0 { 20000 } else { 15000 };
        Self::Avs {
            min_voltage_mv,
            max_voltage_mv,
            pdp_w: 0,
            epr: false,
            max_current_9v_15v_ma: (i_9_15 > 0).then_some(i_9_15),
            max_current_15v_20v_ma: (i_15_20 > 0).then_some(i_15_20),
        }
    }
}

/// One sniffed PD message: the ordered set it arrived on and its bytes on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct PdMessage {
    pub sop: Sop,
    pub header: Option<PdHeader>,
    pub objects: Vec<u32>,
    /// Decoded only for Source_Capabilities / Sink_Capabilities.
    pub pdos: Vec<Pdo>,
    pub wire: Vec<u8>,
}

impl PdMessage {
    pub fn parse(sop: Sop, wire: Vec<u8>) -> Self {
        if wire.len() < 2 {
            return Self {
                sop,
                header: None,
                objects: Vec::new(),
                pdos: Vec::new(),
                wire,
            };
        }
        let header = PdHeader::parse(u16::from_le_bytes([wire[0], wire[1]]));
        let mut objects = Vec::new();
        let mut i = 2;
        let nobj = header.num_objects as usize;
        while objects.len() < nobj && i + 4 <= wire.len() {
            objects.push(u32::from_le_bytes([
                wire[i],
                wire[i + 1],
                wire[i + 2],
                wire[i + 3],
            ]));
            i += 4;
        }
        let pdos =
            if header.is_data() && !header.extended && matches!(header.message_type, 0x01 | 0x04) {
                objects.iter().copied().map(Pdo::parse).collect()
            } else {
                Vec::new()
            };
        Self {
            sop,
            header: Some(header),
            objects,
            pdos,
            wire,
        }
    }

    pub fn type_name(&self) -> &'static str {
        self.header.map(|h| h.type_name()).unwrap_or("Truncated")
    }

    /// Source_Capabilities: the list a later Request is judged against.
    pub fn is_source_capabilities(&self) -> bool {
        self.header
            .is_some_and(|h| h.is_data() && !h.extended && h.message_type == 0x01)
    }

    /// The message bytes without anything the capture appended after them.
    ///
    /// A non-extended message, and one chunk of a chunked extended message, ends after
    /// its data objects; an unchunked extended message ends after its declared data size.
    /// `None` when the wire is too short to hold a header.
    pub fn payload(&self) -> Option<&[u8]> {
        let header = self.header?;
        let end = if header.extended && self.wire.len() >= 4 {
            let ext = u16::from_le_bytes([self.wire[2], self.wire[3]]);
            let chunked = (ext >> 15) & 1 == 1;
            if chunked {
                2 + 4 * header.num_objects as usize
            } else {
                4 + (ext & 0x1FF) as usize
            }
        } else {
            2 + 4 * header.num_objects as usize
        };
        Some(&self.wire[..end.min(self.wire.len())])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pd_status() {
        let mut buf = [0u8; 12];
        buf[0..4].copy_from_slice(&1234u32.to_le_bytes());
        buf[4..6].copy_from_slice(&5000u16.to_le_bytes());
        buf[6..8].copy_from_slice(&(-1500i16).to_le_bytes());
        buf[8..10].copy_from_slice(&1620u16.to_le_bytes());
        let s = PdStatus::parse(&buf).unwrap();
        assert_eq!(s.timestamp_ms, 1234);
        assert!((s.vbus_v() - 5.0).abs() < 1e-9);
        assert!((s.ibus_a() + 1.5).abs() < 1e-9);
        assert!((s.cc1_v() - 1.62).abs() < 1e-9);
    }

    #[test]
    fn parse_connect_event() {
        let raw = [0x45, 0xE2, 0xE8, 0x5B, 0x00, 0x21];
        let events = parse_pd_events(&raw).unwrap();
        assert!(matches!(events[0].kind, PdEventKind::Connect));
        assert_eq!(events[0].timestamp_ms, 0x5B_E8E2);
        let raw = [0x45, 0x00, 0x00, 0x00, 0x00, 0x12];
        assert!(matches!(
            parse_pd_events(&raw).unwrap()[0].kind,
            PdEventKind::Disconnect
        ));
    }

    #[test]
    fn parse_fixed_pdo_5v3a() {
        let voltage_counts = 5000 / 50;
        let current_counts = 3000 / 10;
        let raw = (voltage_counts << 10) | current_counts;
        match Pdo::parse(raw) {
            Pdo::Fixed {
                voltage_mv,
                max_current_ma,
                ..
            } => {
                assert_eq!(voltage_mv, 5000);
                assert_eq!(max_current_ma, 3000);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_goodcrc_message() {
        // Control GoodCRC, spec 3.0, msgID=0
        let header: u16 = 0x01 | (2 << 6);
        let msg = PdMessage::parse(Sop::Sop, header.to_le_bytes().to_vec());
        assert_eq!(msg.type_name(), "GoodCRC");
        assert!(!msg.is_source_capabilities());
        assert_eq!(msg.payload().unwrap().len(), 2);
    }

    #[test]
    fn pd_message_stops_at_num_objects() {
        let nobj = 1u16;
        let header: u16 = 0x01 | (2 << 6) | (nobj << 12);
        let pdo = (100u32 << 10) | 300;
        let mut wire = header.to_le_bytes().to_vec();
        wire.extend_from_slice(&pdo.to_le_bytes());
        wire.extend_from_slice(&[0xFFu8; 8]);
        let msg = PdMessage::parse(Sop::Sop, wire);
        assert_eq!(msg.objects.len(), 1);
        assert_eq!(msg.pdos.len(), 1);
        assert!(msg.is_source_capabilities());
        assert_eq!(
            msg.payload().unwrap().len(),
            6,
            "trailing bytes are not payload"
        );
    }

    #[test]
    fn extended_payload_ends_at_its_declared_size() {
        // Unchunked extended header declaring 3 data bytes, followed by padding.
        let header: u16 = 0x01 | (2 << 6) | (1 << 12) | (1 << 15);
        let ext: u16 = 3;
        let mut wire = header.to_le_bytes().to_vec();
        wire.extend_from_slice(&ext.to_le_bytes());
        wire.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0x00, 0x00, 0x00]);
        let msg = PdMessage::parse(Sop::Sop, wire);
        assert_eq!(
            msg.payload().unwrap(),
            &[0x81, 0x90, 0x03, 0x00, 0xAA, 0xBB, 0xCC][..]
        );
        assert!(msg.pdos.is_empty());
        // A chunked extended message ends after its data objects instead.
        let chunked_ext: u16 = 26 | (1 << 15);
        let mut wire = header.to_le_bytes().to_vec();
        wire.extend_from_slice(&chunked_ext.to_le_bytes());
        wire.extend_from_slice(&[0x11; 10]);
        let msg = PdMessage::parse(Sop::Sop, wire);
        assert_eq!(msg.payload().unwrap().len(), 6);
        assert!(PdMessage::parse(Sop::Sop, vec![0x01]).payload().is_none());
    }

    #[test]
    fn parse_wrapped_pd_event() {
        // size_flag: wire_len 2 → encoded = 7 → 0x87
        let header: u16 = 0x01 | (2 << 6);
        let mut raw = vec![0x87, 0x10, 0x00, 0x00, 0x00, 0x00];
        raw.extend_from_slice(&header.to_le_bytes());
        let events = parse_pd_events(&raw).unwrap();
        match &events[0].kind {
            PdEventKind::Message(m) => assert_eq!(m.type_name(), "GoodCRC"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_pd_events_keeps_prefix_when_padded() {
        let header: u16 = 0x01 | (2 << 6);
        let mut raw = vec![0x87, 0x10, 0x00, 0x00, 0x00, 0x00];
        raw.extend_from_slice(&header.to_le_bytes());
        raw.extend_from_slice(&[0u8; 16]);
        let events = parse_pd_events(&raw).unwrap();
        assert_eq!(events.len(), 1);
        match &events[0].kind {
            PdEventKind::Message(m) => assert_eq!(m.type_name(), "GoodCRC"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_wrapped_source_cap_extracts_pdo() {
        let nobj = 1u16;
        let header: u16 = 0x01 | (2 << 6) | (nobj << 12);
        let pdo = (100u32 << 10) | 300;
        let mut wire = header.to_le_bytes().to_vec();
        wire.extend_from_slice(&pdo.to_le_bytes());
        // wire_len 6 → encoded = 11 → 0x8B
        let mut raw = vec![0x8B, 0x20, 0x00, 0x00, 0x00, 0x01];
        raw.extend_from_slice(&wire);
        raw.extend_from_slice(&[0u8; 8]);
        let events = parse_pd_events(&raw).unwrap();
        match &events[0].kind {
            PdEventKind::Message(m) => {
                assert_eq!(m.type_name(), "Source_Capabilities");
                assert_eq!(m.sop, Sop::SopPrime);
                assert_eq!(m.pdos.len(), 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_spr_avs_dual_current_9_to_20v() {
        let i9 = 3000 / 10;
        let i20 = 5000 / 10;
        let raw = (3u32 << 30) | (2u32 << 28) | (i9 << 10) | i20;
        match Pdo::parse(raw) {
            Pdo::Avs {
                min_voltage_mv,
                max_voltage_mv,
                epr,
                max_current_9v_15v_ma,
                max_current_15v_20v_ma,
                ..
            } => {
                assert!(!epr);
                assert_eq!(min_voltage_mv, 9000);
                assert_eq!(max_voltage_mv, 20000);
                assert_eq!(max_current_9v_15v_ma, Some(3000));
                assert_eq!(max_current_15v_20v_ma, Some(5000));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_epr_avs_min_max_pdp() {
        let max_u = 28000 / 100;
        let min_u = 15000 / 100;
        let raw = (3u32 << 30) | (1u32 << 28) | (max_u << 17) | (min_u << 8) | 140;
        match Pdo::parse(raw) {
            Pdo::Avs {
                min_voltage_mv,
                max_voltage_mv,
                pdp_w,
                epr,
                max_current_9v_15v_ma,
                max_current_15v_20v_ma,
            } => {
                assert!(epr);
                assert_eq!(min_voltage_mv, 15000);
                assert_eq!(max_voltage_mv, 28000);
                assert_eq!(pdp_w, 140);
                assert_eq!(max_current_9v_15v_ma, None);
                assert_eq!(max_current_15v_20v_ma, None);
            }
            other => panic!("{other:?}"),
        }
    }
}
