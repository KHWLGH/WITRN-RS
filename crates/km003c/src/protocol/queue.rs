//! AdcQueue's fixed-width 20-byte samples.

use super::{read_i32, read_u16, ProtocolError, Result};

pub const SAMPLE_SIZE: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueSample {
    pub sequence: u16,
    pub marker: u16,
    pub vbus_uv: i32,
    pub ibus_ua: i32,
    pub cc1_mv: u16,
    pub cc2_mv: u16,
    pub dp_mv: u16,
    pub dm_mv: u16,
}

pub fn parse_samples(bytes: &[u8], count: usize) -> Result<Vec<QueueSample>> {
    let expected = count
        .checked_mul(SAMPLE_SIZE)
        .ok_or(ProtocolError::TooShort {
            need: usize::MAX,
            got: bytes.len(),
        })?;
    if bytes.len() != expected {
        return Err(ProtocolError::TooShort {
            need: expected,
            got: bytes.len(),
        });
    }
    bytes
        .chunks_exact(SAMPLE_SIZE)
        .map(|sample| {
            Ok(QueueSample {
                sequence: read_u16(sample, 0)?,
                marker: read_u16(sample, 2)?,
                vbus_uv: read_i32(sample, 4)?,
                ibus_ua: read_i32(sample, 8)?,
                cc1_mv: read_u16(sample, 12)?,
                cc2_mv: read_u16(sample, 14)?,
                dp_mv: read_u16(sample, 16)?,
                dm_mv: read_u16(sample, 18)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opaque_marker_and_signed_measurements() {
        let mut raw = [0u8; SAMPLE_SIZE];
        raw[0..2].copy_from_slice(&0xFFFEu16.to_le_bytes());
        raw[2..4].copy_from_slice(&0x3Cu16.to_le_bytes());
        raw[4..8].copy_from_slice(&5_000_000i32.to_le_bytes());
        raw[8..12].copy_from_slice(&(-1_250_000i32).to_le_bytes());
        raw[12..14].copy_from_slice(&5000u16.to_le_bytes());
        let sample = parse_samples(&raw, 1).unwrap()[0];
        assert_eq!(sample.sequence, 0xFFFE);
        assert_eq!(sample.marker, 0x3C);
        assert_eq!(sample.vbus_uv, 5_000_000);
        assert_eq!(sample.ibus_ua, -1_250_000);
        assert!(parse_samples(&raw[..19], 1).is_err());
    }
}
