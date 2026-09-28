//! ADC 44/40 字节载荷解析。单位：电压 µV，电流 µA，CC/D+/D- 为 0.1 mV。

use super::{read_i16, read_i32, read_u16, ProtocolError, Result};

pub const ADC_MIN_SIZE: usize = 40;
pub const ADC_FULL_SIZE: usize = 44;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdcData {
    pub vbus_uv: i32,
    pub ibus_ua: i32,
    pub vbus_avg_uv: i32,
    pub ibus_avg_ua: i32,
    pub vbus_ori_avg_uv: i32,
    pub ibus_ori_avg_ua: i32,
    pub temp_raw: i16,
    pub vcc1_tenth_mv: u16,
    pub vcc2_tenth_mv: u16,
    pub vdp_tenth_mv: u16,
    pub vdm_tenth_mv: u16,
    pub vdd_tenth_mv: u16,
    pub sample_rate_idx: u8,
    pub flags: u8,
    pub cc2_avg_mv: u16,
    pub vdp_avg_mv: u16,
    pub vdm_avg_mv: u16,
}

impl AdcData {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < ADC_MIN_SIZE {
            return Err(ProtocolError::TooShort {
                need: ADC_MIN_SIZE,
                got: bytes.len(),
            });
        }

        let extra = bytes.len() >= ADC_FULL_SIZE;
        Ok(Self {
            vbus_uv: read_i32(bytes, 0)?,
            ibus_ua: read_i32(bytes, 4)?,
            vbus_avg_uv: read_i32(bytes, 8)?,
            ibus_avg_ua: read_i32(bytes, 12)?,
            vbus_ori_avg_uv: read_i32(bytes, 16)?,
            ibus_ori_avg_ua: read_i32(bytes, 20)?,
            temp_raw: read_i16(bytes, 24)?,
            vcc1_tenth_mv: read_u16(bytes, 26)?,
            vcc2_tenth_mv: read_u16(bytes, 28)?,
            vdp_tenth_mv: read_u16(bytes, 30)?,
            vdm_tenth_mv: read_u16(bytes, 32)?,
            vdd_tenth_mv: read_u16(bytes, 34)?,
            sample_rate_idx: bytes[36] & 0x03,
            flags: bytes[37],
            cc2_avg_mv: if extra { read_u16(bytes, 38)? } else { 0 },
            vdp_avg_mv: if extra { read_u16(bytes, 40)? } else { 0 },
            vdm_avg_mv: if extra { read_u16(bytes, 42)? } else { 0 },
        })
    }

    pub fn vbus_v(&self) -> f64 {
        f64::from(self.vbus_avg_uv) / 1_000_000.0
    }

    pub fn ibus_a(&self) -> f64 {
        f64::from(self.ibus_avg_ua) / 1_000_000.0
    }

    pub fn vbus_instant_v(&self) -> f64 {
        f64::from(self.vbus_uv) / 1_000_000.0
    }

    pub fn ibus_instant_a(&self) -> f64 {
        f64::from(self.ibus_ua) / 1_000_000.0
    }

    pub fn power_w(&self) -> f64 {
        self.vbus_v() * self.ibus_a()
    }

    /// 内部温度，协议研究确认 LSB = 1/128 ℃。
    pub fn temp_c(&self) -> f64 {
        f64::from(self.temp_raw) / 128.0
    }

    fn tenth_mv_to_v(raw: u16) -> f64 {
        f64::from(raw) / 10_000.0
    }

    pub fn vcc1_v(&self) -> f64 {
        Self::tenth_mv_to_v(self.vcc1_tenth_mv)
    }

    pub fn vcc2_v(&self) -> f64 {
        Self::tenth_mv_to_v(self.vcc2_tenth_mv)
    }

    pub fn vdp_v(&self) -> f64 {
        Self::tenth_mv_to_v(self.vdp_tenth_mv)
    }

    pub fn vdm_v(&self) -> f64 {
        Self::tenth_mv_to_v(self.vdm_tenth_mv)
    }

    pub fn vdd_v(&self) -> f64 {
        Self::tenth_mv_to_v(self.vdd_tenth_mv)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cdc_example_voltage_current() {
        let mut buf = vec![0u8; 40];
        buf[0..4].copy_from_slice(&0x0088_F968u32.to_le_bytes());
        buf[4..8].copy_from_slice(&(-1_056_977i32).to_le_bytes());
        buf[8..12].copy_from_slice(&0x0088_F968u32.to_le_bytes());
        buf[12..16].copy_from_slice(&(-1_056_977i32).to_le_bytes());
        buf[26..28].copy_from_slice(&6330u16.to_le_bytes());
        buf[28..30].copy_from_slice(&3700u16.to_le_bytes());
        buf[30..32].copy_from_slice(&2690u16.to_le_bytes());
        buf[32..34].copy_from_slice(&2780u16.to_le_bytes());

        let adc = AdcData::parse(&buf).unwrap();
        assert!((adc.vbus_v() - 8.976744).abs() < 1e-9);
        assert!((adc.ibus_a() + 1.056977).abs() < 1e-9);
        assert!((adc.vcc1_v() - 0.633).abs() < 1e-9);
        assert!((adc.vdp_v() - 0.269).abs() < 1e-9);
        assert!((adc.power_w() - (8.976744 * -1.056977)).abs() < 1e-6);
        let _ = adc.vbus_instant_v();
        let _ = adc.ibus_instant_a();
    }

    #[test]
    fn rejects_short_payload() {
        assert!(AdcData::parse(&[0u8; 10]).is_err());
    }
}
