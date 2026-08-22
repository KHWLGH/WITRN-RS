//! The general measurement report — voltage, current, temperature and the running
//! totals a WITRN meter streams continuously.

use usbpd_parser::bits::{bits, py_float, Order};
use usbpd_parser::{Metadata, Value};

use crate::error::{Error, Result};

/// A general report occupies the whole 64-byte HID packet.
pub const REPORT_LEN: usize = 64;

/// A general measurement without display formatting or protocol-tree metadata.
///
/// Temperature is optional because that byte range is not a valid temperature on
/// every WITRN firmware. Other fields are rejected when they are not finite, and
/// voltage/current retain the application's trusted operating ranges.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GeneralSample {
    /// Bus voltage in volts.
    pub voltage: f32,
    /// Bus current in amperes.
    pub current: f32,
    /// Calculated bus power in watts.
    pub power: f32,
    /// D+ line voltage in volts.
    pub dp: f32,
    /// D- line voltage in volts.
    pub dn: f32,
    /// CC1 pin voltage in volts.
    pub cc1: f32,
    /// CC2 pin voltage in volts.
    pub cc2: f32,
    /// Meter temperature in degrees Celsius when the field is credible.
    pub temperature: Option<f32>,
    /// Accumulated charge in ampere-hours.
    pub ah: f32,
    /// Accumulated energy in watt-hours.
    pub wh: f32,
}

/// Decode a general (`0xFF`) report into numeric values suitable for an API or UI.
pub fn decode_general_sample(data: &[u8]) -> Result<GeneralSample> {
    if data.len() < REPORT_LEN {
        return Err(Error::ShortReport { len: data.len() });
    }
    if data.len() != REPORT_LEN {
        return Err(Error::InvalidReportLength { len: data.len() });
    }
    if data[0] != 0xFF {
        return Err(Error::UnknownReport { kind: data[0] });
    }

    let f32_at = |i: usize| f32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    let ah = f32_at(14);
    let wh = f32_at(18);
    let dp = f32_at(30);
    let dn = f32_at(34);
    let raw_temperature = f32_at(42);
    let voltage = f32_at(46);
    let current = f32_at(50);

    // K2 标称 ±10 A；略放宽以免过冲 / 量化把整帧丢掉。远超量程的才当坏帧。
    if !(0.0..=60.0).contains(&voltage) || !(-20.0..=20.0).contains(&current) {
        return Err(Error::InvalidMeasurement {
            field: "voltage/current",
        });
    }
    if !ah.is_finite() || !wh.is_finite() {
        return Err(Error::InvalidMeasurement {
            field: "accumulated values",
        });
    }

    Ok(GeneralSample {
        voltage,
        current,
        power: voltage * current,
        dp,
        dn,
        cc1: data[55] as f32 / 10.0,
        cc2: data[56] as f32 / 10.0,
        temperature: (-40.0..=150.0)
            .contains(&raw_temperature)
            .then_some(raw_temperature),
        ah,
        wh,
    })
}

/// Field names of the `general` tree, as one definition rather than a literal at
/// every lookup.
///
/// The measurements are read back out of the tree by name — including from other
/// crates, where a rename would compile cleanly and simply stop matching. See
/// [`usbpd_parser::fields`] for the PD side.
///
/// ```
/// use witrn_hid::{fields, general_msg, REPORT_LEN};
///
/// let mut report = [0u8; REPORT_LEN];
/// report[0] = 0xFF;
/// report[46..50].copy_from_slice(&5.0f32.to_le_bytes());
///
/// let msg = general_msg(&report)?;
/// assert_eq!(msg.get(fields::VBUS).unwrap().value().as_str(), Some("5.0V"));
/// # Ok::<_, witrn_hid::Error>(())
/// ```
pub mod fields {
    /// The root node of a decoded measurement report.
    pub const GENERAL: &str = "general";
    /// Charge delivered since the meter's counters were reset.
    pub const AH: &str = "Ah";
    /// Energy delivered since the meter's counters were reset.
    pub const WH: &str = "Wh";
    /// How long the meter has been recording.
    pub const RECTIME: &str = "Rectime";
    /// How long the load has been connected.
    pub const RUNTIME: &str = "Runtime";
    /// D+ line voltage.
    pub const D_PLUS: &str = "D+";
    /// D− line voltage.
    pub const D_MINUS: &str = "D-";
    /// Meter temperature.
    pub const TEMPERATURE: &str = "Temperature";
    /// Bus voltage.
    pub const VBUS: &str = "VBus";
    /// Bus current.
    pub const CURRENT: &str = "Current";
    /// The meter's record group, as its own display numbers them.
    pub const GROUP: &str = "Group";
    /// CC1 pin voltage.
    pub const CC1: &str = "CC1";
    /// CC2 pin voltage.
    pub const CC2: &str = "CC2";
}

/// Decode a general (`0xFF`) report into the same `general` tree the Python API
/// produced.
///
/// Field positions are the meter's, not the USB-PD spec's: `bit_loc` counts from the
/// start of the 64-byte report.
pub fn general_msg(data: &[u8]) -> Result<Metadata> {
    if data.len() < REPORT_LEN {
        return Err(Error::ShortReport { len: data.len() });
    }

    let f32_at =
        |i: usize| f32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as f64;
    let u32_at = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    let raw = |a: usize, b: usize| bits(&data[a..b], Order::Little);

    let fields = vec![
        Metadata::new(
            raw(14, 18),
            (112, 143),
            fields::AH,
            format!("{}Ah", py_float(f32_at(14))),
        ),
        Metadata::new(
            raw(18, 22),
            (144, 175),
            fields::WH,
            format!("{}Wh", py_float(f32_at(18))),
        ),
        Metadata::new(
            raw(22, 26),
            (176, 207),
            fields::RECTIME,
            duration(u32_at(22)),
        ),
        Metadata::new(
            raw(26, 30),
            (208, 239),
            fields::RUNTIME,
            duration(u32_at(26)),
        ),
        Metadata::new(
            raw(30, 34),
            (240, 271),
            fields::D_PLUS,
            format!("{}V", py_float(f32_at(30))),
        ),
        Metadata::new(
            raw(34, 38),
            (272, 303),
            fields::D_MINUS,
            format!("{}V", py_float(f32_at(34))),
        ),
        Metadata::new(
            raw(42, 46),
            (336, 367),
            fields::TEMPERATURE,
            format!("{}\u{b0}C", py_float(f32_at(42))),
        ),
        Metadata::new(
            raw(46, 50),
            (368, 399),
            fields::VBUS,
            format!("{}V", py_float(f32_at(46))),
        ),
        Metadata::new(
            raw(50, 54),
            (400, 431),
            fields::CURRENT,
            format!("{}A", py_float(f32_at(50))),
        ),
        // Groups are numbered from 1 on the meter's own display.
        Metadata::new(
            raw(54, 55),
            (432, 439),
            fields::GROUP,
            format!("{}", data[54] as u16 + 1),
        ),
        Metadata::new(
            raw(55, 56),
            (440, 447),
            fields::CC1,
            format!("{}V", py_float(data[55] as f64 / 10.0)),
        ),
        Metadata::new(
            raw(56, 57),
            (448, 455),
            fields::CC2,
            format!("{}V", py_float(data[56] as f64 / 10.0)),
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        (0, 511),
        fields::GENERAL,
        Value::List(fields),
    ))
}

/// Format a whole number of seconds the way Python's `str(timedelta(...))` does:
/// `"1:02:03"`, or `"2 days, 0:00:00"` past a day.
fn duration(seconds: u32) -> String {
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (h, m, s) = (rest / 3600, rest % 3600 / 60, rest % 60);
    match days {
        0 => format!("{h}:{m:02}:{s:02}"),
        1 => format!("1 day, {h}:{m:02}:{s:02}"),
        n => format!("{n} days, {h}:{m:02}:{s:02}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A report with 5.001 V on VBus, 1.5 A, 25.5 °C, 3661 s of runtime.
    fn report() -> [u8; REPORT_LEN] {
        let mut d = [0u8; REPORT_LEN];
        d[0] = 0xFF;
        d[14..18].copy_from_slice(&1.25f32.to_le_bytes()); // Ah
        d[18..22].copy_from_slice(&6.5f32.to_le_bytes()); // Wh
        d[22..26].copy_from_slice(&90_061u32.to_le_bytes()); // Rectime: 1 day
        d[26..30].copy_from_slice(&3_661u32.to_le_bytes()); // Runtime
        d[30..34].copy_from_slice(&0.6f32.to_le_bytes()); // D+
        d[34..38].copy_from_slice(&0.6f32.to_le_bytes()); // D-
        d[42..46].copy_from_slice(&25.5f32.to_le_bytes()); // Temperature
        d[46..50].copy_from_slice(&5.001f32.to_le_bytes()); // VBus
        d[50..54].copy_from_slice(&1.5f32.to_le_bytes()); // Current
        d[54] = 2; // Group (displayed as 3)
        d[55] = 16; // CC1 = 1.6 V
        d[56] = 0; // CC2 = 0.0 V
        d
    }

    #[test]
    fn decodes_every_measurement() {
        let msg = general_msg(&report()).unwrap();
        assert_eq!(msg.field(), "general");
        assert_eq!(
            msg.get("VBus").unwrap().value().as_str(),
            Some("5.000999927520752V")
        );
        assert_eq!(msg.get("Current").unwrap().value().as_str(), Some("1.5A"));
        assert_eq!(
            msg.get("Temperature").unwrap().value().as_str(),
            Some("25.5\u{b0}C")
        );
        assert_eq!(msg.get("Ah").unwrap().value().as_str(), Some("1.25Ah"));
        assert_eq!(msg.get("Wh").unwrap().value().as_str(), Some("6.5Wh"));
    }

    #[test]
    fn decodes_numeric_sample_without_formatting_strings() {
        let sample = decode_general_sample(&report()).unwrap();
        assert_eq!(sample.voltage, 5.001);
        assert_eq!(sample.current, 1.5);
        assert_eq!(sample.power, sample.voltage * sample.current);
        assert_eq!(sample.temperature, Some(25.5));
        assert_eq!(sample.cc1, 1.6);
    }

    #[test]
    fn invalid_temperature_is_missing_without_dropping_the_frame() {
        let mut data = report();
        data[42..46].copy_from_slice(&150.1f32.to_le_bytes());
        assert_eq!(decode_general_sample(&data).unwrap().temperature, None);
    }

    #[test]
    fn rejects_wrong_kind_and_untrusted_measurements() {
        let mut data = report();
        data[0] = 0xFE;
        assert!(matches!(
            decode_general_sample(&data),
            Err(Error::UnknownReport { kind: 0xFE })
        ));

        let mut data = report();
        data[46..50].copy_from_slice(&60.1f32.to_le_bytes());
        assert!(matches!(
            decode_general_sample(&data),
            Err(Error::InvalidMeasurement { .. })
        ));

        let mut data = report();
        data[50..54].copy_from_slice(&10.1f32.to_le_bytes());
        assert!(
            decode_general_sample(&data).is_ok(),
            "slight current overshoot must not drop the frame"
        );

        let mut data = report();
        data[50..54].copy_from_slice(&20.1f32.to_le_bytes());
        assert!(matches!(
            decode_general_sample(&data),
            Err(Error::InvalidMeasurement { .. })
        ));
    }

    #[test]
    fn numeric_decoder_requires_exactly_one_hid_report() {
        let mut data = report().to_vec();
        data.push(0);
        assert!(matches!(
            decode_general_sample(&data),
            Err(Error::InvalidReportLength { len: 65 })
        ));
    }

    #[test]
    fn group_is_reported_one_based() {
        let msg = general_msg(&report()).unwrap();
        assert_eq!(msg.get("Group").unwrap().value().as_str(), Some("3"));
    }

    #[test]
    fn cc_pins_are_tenths_of_a_volt() {
        let msg = general_msg(&report()).unwrap();
        assert_eq!(msg.get("CC1").unwrap().value().as_str(), Some("1.6V"));
        assert_eq!(msg.get("CC2").unwrap().value().as_str(), Some("0.0V"));
    }

    #[test]
    fn durations_match_pythons_timedelta_formatting() {
        assert_eq!(duration(0), "0:00:00");
        assert_eq!(duration(59), "0:00:59");
        assert_eq!(duration(3_661), "1:01:01");
        assert_eq!(duration(86_400), "1 day, 0:00:00");
        assert_eq!(duration(90_061), "1 day, 1:01:01");
        assert_eq!(duration(172_800), "2 days, 0:00:00");
    }

    #[test]
    fn the_report_spans_all_512_bits() {
        let msg = general_msg(&report()).unwrap();
        assert_eq!(msg.bit_loc(), usbpd_parser::BitLoc::Bits(0, 511));
        assert_eq!(msg.raw().as_str().len(), 512);
    }
}
