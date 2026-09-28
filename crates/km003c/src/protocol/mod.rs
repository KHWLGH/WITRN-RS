//! KM003C 应用层协议：4 字节小端包头 + 逻辑包。

pub mod adc;
pub mod auth;
pub mod pd;
pub mod queue;

pub use adc::AdcData;
pub use pd::{PdEvent, PdEventKind, PdStatus};
pub use queue::QueueSample;

use thiserror::Error;

pub const HEADER_SIZE: usize = 4;
pub const ADC_ATTR: u16 = 0x0001;
pub const ADC_QUEUE_ATTR: u16 = 0x0002;
pub const SETTINGS_ATTR: u16 = 0x0008;
pub const PD_PACKET_ATTR: u16 = 0x0010;
pub const PD_TRACE_ATTR: u16 = 0x0020;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("packet too short: need {need} bytes, got {got}")]
    TooShort { need: usize, got: usize },
    #[error("unexpected packet type 0x{0:02X}, expected {1}")]
    UnexpectedType(u8, &'static str),
    #[error("command rejected (type=0x06)")]
    Rejected,
    #[error("invalid PD event at offset {offset}: {reason}")]
    InvalidPd { offset: usize, reason: String },
    #[error("invalid AdcQueue payload: expected {need} bytes, got {got}")]
    InvalidQueue { need: usize, got: usize },
}

pub type Result<T> = std::result::Result<T, ProtocolError>;

/// 控制/数据命令类型。小于 0x40 为控制，大于等于 0x40 为数据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Command {
    Sync = 0x01,
    Connect = 0x02,
    Disconnect = 0x03,
    Reset = 0x04,
    Accept = 0x05,
    Reject = 0x06,
    Finished = 0x07,
    GetStatus = 0x0A,
    Error = 0x0B,
    GetData = 0x0C,
    GetFile = 0x0D,
    StartGraph = 0x0E,
    StopGraph = 0x0F,
    EnablePdMonitor = 0x10,
    DisablePdMonitor = 0x11,
    Head = 0x40,
    PutData = 0x41,
}

impl Command {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0x01 => Self::Sync,
            0x02 => Self::Connect,
            0x03 => Self::Disconnect,
            0x04 => Self::Reset,
            0x05 => Self::Accept,
            0x06 => Self::Reject,
            0x07 => Self::Finished,
            0x0A => Self::GetStatus,
            0x0B => Self::Error,
            0x0C => Self::GetData,
            0x0D => Self::GetFile,
            0x0E => Self::StartGraph,
            0x0F => Self::StopGraph,
            0x10 => Self::EnablePdMonitor,
            0x11 => Self::DisablePdMonitor,
            0x40 => Self::Head,
            0x41 => Self::PutData,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attribute(pub u16);

impl Attribute {
    pub const ADC: Self = Self(ADC_ATTR);
    pub const ADC_QUEUE: Self = Self(ADC_QUEUE_ATTR);
    pub const SETTINGS: Self = Self(SETTINGS_ATTR);
    pub const PD_PACKET: Self = Self(PD_PACKET_ATTR);
    pub const PD_TRACE: Self = Self(PD_TRACE_ATTR);
    pub const ADC_AND_PD: Self = Self(ADC_ATTR | PD_PACKET_ATTR);

    pub fn bits(self) -> u16 {
        self.0
    }

    pub fn name(self) -> &'static str {
        match self.0 {
            ADC_ATTR => "ADC",
            ADC_QUEUE_ATTR => "AdcQueue",
            SETTINGS_ATTR => "Settings",
            PD_PACKET_ATTR => "PdPacket",
            PD_TRACE_ATTR => "PdTrace",
            _ => "Unknown",
        }
    }
}

impl std::ops::BitOr for Attribute {
    type Output = Self;
    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

/// 控制头：type:7 | reserved:1 | tid:8 | unused:1 | att:15
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CtrlHeader {
    pub packet_type: u8,
    pub reserved: bool,
    pub id: u8,
    pub attribute: u16,
}

impl CtrlHeader {
    pub fn new(cmd: Command, id: u8, attribute: u16) -> Self {
        Self {
            packet_type: cmd as u8,
            reserved: false,
            id,
            attribute,
        }
    }

    pub fn encode(self) -> [u8; 4] {
        encode_ctrl(self.packet_type, self.id, self.attribute)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let word = read_u32(bytes, 0)?;
        Ok(Self {
            packet_type: (word & 0x7F) as u8,
            reserved: ((word >> 7) & 1) == 1,
            id: ((word >> 8) & 0xFF) as u8,
            attribute: ((word >> 17) & 0x7FFF) as u16,
        })
    }
}

/// 编码控制头。att 从 bit17 开始，线路上 byte2 = att << 1。
pub fn encode_ctrl(cmd: u8, tid: u8, att: u16) -> [u8; 4] {
    let word = (u32::from(cmd) & 0x7F) | (u32::from(tid) << 8) | (u32::from(att) << 17);
    word.to_le_bytes()
}

/// PutData 扩展头：att:15 | next:1 | chunk:6 | size:10
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtHeader {
    pub attribute: u16,
    pub next: bool,
    pub chunk: u8,
    pub size: u16,
}

impl ExtHeader {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let word = read_u32(bytes, 0)?;
        Ok(Self {
            attribute: (word & 0x7FFF) as u16,
            next: ((word >> 15) & 1) == 1,
            chunk: ((word >> 16) & 0x3F) as u8,
            size: ((word >> 22) & 0x3FF) as u16,
        })
    }

    pub fn encode(self) -> [u8; 4] {
        let mut word = u32::from(self.attribute) & 0x7FFF;
        if self.next {
            word |= 1 << 15;
        }
        word |= (u32::from(self.chunk) & 0x3F) << 16;
        word |= (u32::from(self.size) & 0x3FF) << 22;
        word.to_le_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogicalPacket {
    pub attribute: u16,
    pub chunk: u8,
    pub payload: Vec<u8>,
}

/// 一次 GetData 的解析结果。
#[derive(Debug, Clone, Default)]
pub struct DataResponse {
    pub id: u8,
    pub adc: Option<AdcData>,
    pub pd_status: Option<PdStatus>,
    pub pd_events: Vec<PdEvent>,
    pub queue: Vec<QueueSample>,
    pub raw_packets: Vec<LogicalPacket>,
}

/// 解析设备回复：Accept / Reject / PutData。
pub fn parse_response(bytes: &[u8]) -> Result<ParsedResponse> {
    let header = CtrlHeader::parse(bytes)?;
    match header.packet_type {
        x if x == Command::Accept as u8 => Ok(ParsedResponse::Accept { id: header.id }),
        x if x == Command::Reject as u8 => Ok(ParsedResponse::Reject { id: header.id }),
        x if x == Command::PutData as u8 => Ok(ParsedResponse::Data(parse_put_data(bytes)?)),
        other => Err(ProtocolError::UnexpectedType(
            other,
            "Accept/Reject/PutData",
        )),
    }
}

#[derive(Debug, Clone)]
pub enum ParsedResponse {
    Accept { id: u8 },
    Reject { id: u8 },
    Data(DataResponse),
}

pub fn parse_put_data(bytes: &[u8]) -> Result<DataResponse> {
    let header = CtrlHeader::parse(bytes)?;
    if header.packet_type != Command::PutData as u8 {
        return Err(ProtocolError::UnexpectedType(
            header.packet_type,
            "PutData (0x41)",
        ));
    }

    let mut offset = HEADER_SIZE;
    let mut packets = Vec::new();

    if bytes.len() == HEADER_SIZE {
        return Ok(DataResponse {
            id: header.id,
            raw_packets: packets,
            ..Default::default()
        });
    }

    loop {
        if bytes.len().saturating_sub(offset) < HEADER_SIZE {
            break;
        }
        let ext = ExtHeader::parse(&bytes[offset..])?;
        offset += HEADER_SIZE;
        let size = if ext.attribute == ADC_QUEUE_ATTR {
            if ext.size as usize != queue::SAMPLE_SIZE {
                return Err(ProtocolError::InvalidQueue {
                    need: queue::SAMPLE_SIZE,
                    got: ext.size as usize,
                });
            }
            usize::from(ext.chunk) * queue::SAMPLE_SIZE
        } else {
            ext.size as usize
        };
        if offset.saturating_add(size) > bytes.len() {
            return Err(ProtocolError::TooShort {
                need: offset + size,
                got: bytes.len(),
            });
        }
        packets.push(LogicalPacket {
            attribute: ext.attribute,
            chunk: ext.chunk,
            payload: bytes[offset..offset + size].to_vec(),
        });
        offset += size;
        if !ext.next {
            break;
        }
    }

    let mut adc = None;
    let mut pd_status = None;
    let mut pd_events = Vec::new();
    let mut queue = Vec::new();
    for packet in &packets {
        match packet.attribute {
            ADC_ATTR => {
                if let Ok(parsed) = AdcData::parse(&packet.payload) {
                    adc = Some(parsed);
                }
            }
            PD_PACKET_ATTR => match pd::parse_pd_payload(&packet.payload) {
                Ok(parsed) => {
                    pd_status = Some(parsed.status);
                    pd_events = parsed.events;
                }
                Err(ProtocolError::TooShort { .. }) if packet.payload.is_empty() => {}
                Err(_) => {
                    if let Ok(status) = pd::PdStatus::parse(&packet.payload) {
                        pd_status = Some(status);
                        if packet.payload.len() > pd::PD_STATUS_SIZE {
                            if let Ok(events) =
                                pd::parse_pd_events(&packet.payload[pd::PD_STATUS_SIZE..])
                            {
                                pd_events = events;
                            }
                        }
                    }
                }
            },
            ADC_QUEUE_ATTR => {
                let count = packet.payload.len() / queue::SAMPLE_SIZE;
                if let Ok(parsed) = queue::parse_samples(&packet.payload, count) {
                    // A malformed queue packet must not turn into a partial recording.
                    queue = parsed;
                }
            }
            _ => {}
        }
    }

    Ok(DataResponse {
        id: header.id,
        adc,
        pd_status,
        pd_events,
        queue,
        raw_packets: packets,
    })
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset + 4;
    let slice = bytes.get(offset..end).ok_or(ProtocolError::TooShort {
        need: end,
        got: bytes.len(),
    })?;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

pub(crate) fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset + 2;
    let slice = bytes.get(offset..end).ok_or(ProtocolError::TooShort {
        need: end,
        got: bytes.len(),
    })?;
    Ok(u16::from_le_bytes(slice.try_into().unwrap()))
}

pub(crate) fn read_i32(bytes: &[u8], offset: usize) -> Result<i32> {
    Ok(read_u32(bytes, offset)? as i32)
}

pub(crate) fn read_i16(bytes: &[u8], offset: usize) -> Result<i16> {
    Ok(read_u16(bytes, offset)? as i16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_get_data_attributes() {
        for (attributes, expected) in [
            (ADC_ATTR, [0x0C, 0x00, 0x02, 0x00]),
            (PD_PACKET_ATTR, [0x0C, 0x00, 0x20, 0x00]),
            (ADC_ATTR | PD_PACKET_ATTR, [0x0C, 0x00, 0x22, 0x00]),
        ] {
            assert_eq!(
                encode_ctrl(Command::GetData as u8, 0, attributes),
                expected,
                "attributes={attributes:#x}"
            );
        }
    }

    #[test]
    fn encode_connect() {
        assert_eq!(
            encode_ctrl(Command::Connect as u8, 1, 0),
            [0x02, 0x01, 0x00, 0x00]
        );
    }

    #[test]
    fn parse_ext_header_official_adc() {
        // 01 00 00 0A → att=1, next=0, chunk=0, size=40
        let ext = ExtHeader::parse(&[0x01, 0x00, 0x00, 0x0A]).unwrap();
        assert_eq!(ext.attribute, 1);
        assert!(!ext.next);
        assert_eq!(ext.chunk, 0);
        assert_eq!(ext.size, 40);
        assert_eq!(ext.encode(), [0x01, 0x00, 0x00, 0x0A]);
    }

    #[test]
    fn protocol_surface() {
        assert_eq!(Command::from_u8(0x0C), Some(Command::GetData));
        assert_eq!(Attribute::ADC.name(), "ADC");
        assert_eq!(Attribute::PD_PACKET.bits(), PD_PACKET_ATTR);
        let _ = Attribute::ADC_QUEUE;
        let _ = Attribute::SETTINGS;
        let _ = Attribute::PD_TRACE;
        let encoded = CtrlHeader::new(Command::GetData, 0, Attribute::ADC.bits()).encode();
        assert_eq!(encoded, [0x0C, 0x00, 0x02, 0x00]);
        let _ = ProtocolError::Rejected;
        let _ = Command::Sync;
        let _ = Command::Reset;
        let _ = Command::Finished;
        let _ = Command::GetStatus;
        let _ = Command::Error;
        let _ = Command::GetFile;
        let _ = Command::StartGraph;
        let _ = Command::StopGraph;
        let _ = Command::EnablePdMonitor;
        let _ = Command::DisablePdMonitor;
        let _ = Command::Head;
    }

    #[test]
    fn parse_put_data_adc_only() {
        let mut packet = Vec::new();
        packet.extend_from_slice(&[0x41, 0x09, 0x00, 0x00]);
        packet.extend_from_slice(
            &ExtHeader {
                attribute: ADC_ATTR,
                next: false,
                chunk: 0,
                size: 40,
            }
            .encode(),
        );
        let mut payload = vec![0u8; 40];
        payload[0..4].copy_from_slice(&8_976_744i32.to_le_bytes());
        payload[4..8].copy_from_slice(&(-1_056_977i32).to_le_bytes());
        payload[8..12].copy_from_slice(&8_976_744i32.to_le_bytes());
        payload[12..16].copy_from_slice(&(-1_056_977i32).to_le_bytes());
        packet.extend_from_slice(&payload);
        packet.extend_from_slice(&[0u8; 16]);

        let resp = parse_put_data(&packet).unwrap();
        let adc = resp.adc.unwrap();
        assert!((adc.vbus_v() - 8.976744).abs() < 1e-9);
        assert!((adc.ibus_a() + 1.056977).abs() < 1e-9);
        let _ = resp.id;
        let _ = resp.raw_packets;
    }

    #[test]
    fn parse_put_data_queue_uses_chunk_times_sample_size() {
        let mut packet = vec![0x41, 1, 0, 0];
        packet.extend_from_slice(
            &ExtHeader {
                attribute: ADC_QUEUE_ATTR,
                next: false,
                chunk: 2,
                size: queue::SAMPLE_SIZE as u16,
            }
            .encode(),
        );
        for (seq, current) in [(100u16, 2_000_000i32), (101, -500_000)] {
            packet.extend_from_slice(&seq.to_le_bytes());
            packet.extend_from_slice(&0x3Cu16.to_le_bytes());
            packet.extend_from_slice(&5_000_000i32.to_le_bytes());
            packet.extend_from_slice(&current.to_le_bytes());
            packet.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        }
        let parsed = parse_put_data(&packet).unwrap();
        assert_eq!(parsed.queue.len(), 2);
        assert_eq!(parsed.queue[1].sequence, 101);
        assert_eq!(parsed.queue[1].ibus_ua, -500_000);
    }

    #[test]
    fn parse_put_data_pd_keeps_events_when_padded() {
        let header: u16 = 0x01 | (2 << 6);
        let mut events = vec![0x87, 0x10, 0x00, 0x00, 0x00, 0x00];
        events.extend_from_slice(&header.to_le_bytes());
        events.extend_from_slice(&[0u8; 12]);
        let mut payload = vec![0u8; pd::PD_STATUS_SIZE];
        payload[4..6].copy_from_slice(&5000u16.to_le_bytes());
        payload.extend_from_slice(&events);

        let mut packet = Vec::new();
        packet.extend_from_slice(&[0x41, 0x09, 0x00, 0x00]);
        packet.extend_from_slice(
            &ExtHeader {
                attribute: PD_PACKET_ATTR,
                next: false,
                chunk: 0,
                size: payload.len() as u16,
            }
            .encode(),
        );
        packet.extend_from_slice(&payload);

        let resp = parse_put_data(&packet).unwrap();
        assert!(resp.pd_status.is_some());
        assert_eq!(resp.pd_events.len(), 1);
        match &resp.pd_events[0].kind {
            pd::PdEventKind::Message(m) => assert_eq!(m.type_name(), "GoodCRC"),
            other => panic!("{other:?}"),
        }
    }
}
