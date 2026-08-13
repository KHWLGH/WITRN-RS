//! Request Data Objects — what a Sink asks for, decoded against the PDO it names.

use std::borrow::Cow;

use crate::bits::{flag, num, py_float, require_object, sl};
use crate::error::{ParseError, Result};
use crate::metadata::{Metadata, SupplyType, Value};

/// Dispatch a 32-bit RDO on the supply type of the PDO it is requesting.
///
/// `pdo` is the object at the RDO's Object Position within the stored
/// Source_Capabilities; the RDO's own layout depends on it. The choice is made from
/// [`Metadata::supply_type`], not from the printed `Supply Type` text, so rewording
/// a label cannot quietly change how a message decodes.
pub(crate) fn parse_rdo(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    pdo: Metadata,
    prop: bool,
) -> Result<Metadata> {
    // The same guard `parse_pdo` applies. Without it a short object still decodes:
    // the trailing current fields read from whatever bits are left, so a truncated
    // Request reports a plausible operating current instead of failing.
    require_object(raw, "RDO")?;

    match pdo.supply_type() {
        Some(SupplyType::Fixed | SupplyType::Variable) => fixed_variable(raw, bit_loc, field, pdo),
        Some(SupplyType::Battery) => battery(raw, bit_loc, field, pdo),
        Some(SupplyType::Pps) => pps(raw, bit_loc, field, pdo, prop),
        Some(SupplyType::SprAvs | SupplyType::EprAvs) => avs(raw, bit_loc, field, pdo),
        // An unassigned APDO type, or a Sink PDO — neither names a layout to use.
        _ => Err(ParseError::Unsupported {
            what: "RDO for this supply type",
        }),
    }
}

/// The six flag bits every RDO shares, at bits 26..=22.
fn common_flags(raw: &str, f: &'static str) -> Result<[Metadata; 5]> {
    Ok([
        Metadata::new(
            sl(raw, 5, 6),
            (26, 26),
            "Capability Mismatch",
            flag(sl(raw, 5, 6), f)?,
        ),
        Metadata::new(
            sl(raw, 6, 7),
            (25, 25),
            "USB Communications Capable",
            flag(sl(raw, 6, 7), f)?,
        ),
        Metadata::new(
            sl(raw, 7, 8),
            (24, 24),
            "No USB Suspend",
            flag(sl(raw, 7, 8), f)?,
        ),
        Metadata::new(
            sl(raw, 8, 9),
            (23, 23),
            "Unchunked Extended Messages Supported",
            flag(sl(raw, 8, 9), f)?,
        ),
        Metadata::new(
            sl(raw, 9, 10),
            (22, 22),
            "EPR Capable",
            flag(sl(raw, 9, 10), f)?,
        ),
    ])
}

/// `"5.0V"` -> `"5.0"`, for building a `"5.0-20.0V"` range.
fn drop_unit(s: &str) -> &str {
    s.strip_suffix(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(s)
}

fn pdo_field<'a>(pdo: &'a Metadata, name: &str) -> &'a str {
    pdo.get(name)
        .and_then(|m| m.value().as_str())
        .unwrap_or("?")
}

// ------------------------------------------------ Fixed and Variable Request

fn fixed_variable(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    pdo: Metadata,
) -> Result<Metadata> {
    const F: &str = "Fixed/Variable RDO";

    let position = num(sl(raw, 0, 4), F)?;
    let operating = format!("{}A", py_float(num(sl(raw, 12, 22), F)? as f64 / 100.0));

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 4), (31, 28), "Object Position", position),
        Metadata::new(sl(raw, 4, 5), (27, 27), "Giveback", flag(sl(raw, 4, 5), F)?),
    ];
    fields.extend(common_flags(raw, F)?);
    fields.extend([
        Metadata::reserved(sl(raw, 10, 12), (21, 20)),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Operating Current",
            operating.clone(),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Operating Current",
            format!("{}A", py_float(num(sl(raw, 22, 32), F)? as f64 / 100.0)),
        ),
    ]);

    let epr = position >= 8;
    let quick = if pdo.supply_type() == Some(SupplyType::Fixed) {
        let prefix = if epr { "EF" } else { "F" };
        format!(
            "[{position}] {prefix} {}@{operating}",
            pdo_field(&pdo, "Voltage")
        )
    } else {
        let prefix = if epr { "EV" } else { "V" };
        format!(
            "[{position}] {prefix} {}-{}@{operating}",
            drop_unit(pdo_field(&pdo, "Minimum Voltage")),
            pdo_field(&pdo, "Maximum Voltage")
        )
    };

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields))
        .with_pdo(pdo)
        .with_quick_rdo(quick))
}

// ------------------------------------------------------------ Battery Request

fn battery(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    pdo: Metadata,
) -> Result<Metadata> {
    const F: &str = "Battery RDO";

    let position = num(sl(raw, 0, 4), F)?;
    let operating = format!("{}W", py_float(num(sl(raw, 12, 22), F)? as f64 / 4.0));

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 4), (31, 28), "Object Position", position),
        Metadata::new(sl(raw, 4, 5), (27, 27), "Giveback", flag(sl(raw, 4, 5), F)?),
    ];
    fields.extend(common_flags(raw, F)?);
    fields.extend([
        Metadata::reserved(sl(raw, 10, 12), (21, 20)),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Operating Power",
            operating.clone(),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Operating Power",
            format!("{}W", py_float(num(sl(raw, 22, 32), F)? as f64 / 4.0)),
        ),
    ]);

    let prefix = if position >= 8 { "EB" } else { "B" };
    let quick = format!(
        "[{position}] {prefix} {}-{}@{operating}",
        drop_unit(pdo_field(&pdo, "Minimum Voltage")),
        pdo_field(&pdo, "Maximum Voltage")
    );

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields))
        .with_pdo(pdo)
        .with_quick_rdo(quick))
}

// ---------------------------------------------------------------- PPS Request

fn pps(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    pdo: Metadata,
    prop: bool,
) -> Result<Metadata> {
    const F: &str = "PPS RDO";

    let position = num(sl(raw, 0, 4), F)?;

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 4), (31, 28), "Object Position", position),
        Metadata::reserved(sl(raw, 4, 5), (27, 27)),
    ];
    fields.extend(common_flags(raw, F)?);

    let (voltage, current) = if prop {
        let voltage = format!("{}V", py_float(num(sl(raw, 10, 23), F)? as f64 / 50.0));
        let current = format!("{}A", py_float(num(sl(raw, 23, 32), F)? as f64 / 20.0));
        fields.extend([
            Metadata::new(sl(raw, 10, 23), (21, 9), "Output Voltage", voltage.clone()),
            Metadata::new(
                sl(raw, 23, 32),
                (8, 0),
                "Operating Current",
                current.clone(),
            ),
        ]);
        (voltage, current)
    } else {
        let voltage = format!("{}V", py_float(num(sl(raw, 11, 23), F)? as f64 / 50.0));
        let current = format!("{}A", py_float(num(sl(raw, 25, 32), F)? as f64 / 20.0));
        fields.extend([
            Metadata::reserved(sl(raw, 10, 11), (21, 21)),
            Metadata::new(sl(raw, 11, 23), (20, 9), "Output Voltage", voltage.clone()),
            Metadata::reserved(sl(raw, 23, 25), (8, 7)),
            Metadata::new(
                sl(raw, 25, 32),
                (6, 0),
                "Operating Current",
                current.clone(),
            ),
        ]);
        (voltage, current)
    };

    let quick = format!("[{position}] P {voltage}@{current}");
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields))
        .with_pdo(pdo)
        .with_quick_rdo(quick))
}

// ---------------------------------------------------------------- AVS Request

fn avs(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    pdo: Metadata,
) -> Result<Metadata> {
    const F: &str = "AVS RDO";

    let position = num(sl(raw, 0, 4), F)?;
    let voltage = format!("{}V", py_float(num(sl(raw, 11, 23), F)? as f64 / 40.0));
    let current = format!("{}A", py_float(num(sl(raw, 25, 32), F)? as f64 / 20.0));

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 4), (31, 28), "Object Position", position),
        Metadata::reserved(sl(raw, 4, 5), (27, 27)),
    ];
    fields.extend(common_flags(raw, F)?);
    fields.extend([
        Metadata::reserved(sl(raw, 10, 11), (21, 21)),
        Metadata::new(sl(raw, 11, 23), (20, 9), "Output Voltage", voltage.clone()),
        Metadata::reserved(sl(raw, 23, 25), (8, 7)),
        Metadata::new(
            sl(raw, 25, 32),
            (6, 0),
            "Operating Current",
            current.clone(),
        ),
    ]);

    let prefix = if position >= 8 { "EA" } else { "SA" };
    let quick = format!("[{position}] {prefix} {voltage}@{current}");

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields))
        .with_pdo(pdo)
        .with_quick_rdo(quick))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::{bits, Order};
    use crate::pdo::parse_pdo;

    fn pdo_of(bytes: [u8; 4], name: &'static str) -> Metadata {
        parse_pdo(&bits(&bytes, Order::Little), (0, 31), name, false).unwrap()
    }

    #[test]
    fn decodes_a_fixed_request_against_its_pdo() {
        let pdo = pdo_of([0x2C, 0x91, 0x01, 0x08], "PDO 1");
        // 0x1004B12C: object position 1, operating 3.00 A, max 3.00 A.
        let raw = bits(&[0x2C, 0xB1, 0x04, 0x10], Order::Little);
        let rdo = parse_rdo(&raw, (0, 31), "RDO", pdo, false).unwrap();

        assert_eq!(
            rdo.get("Object Position").unwrap().value().as_int(),
            Some(1)
        );
        assert_eq!(
            rdo.get("Operating Current").unwrap().value().as_str(),
            Some("3.0A")
        );
        assert_eq!(rdo.quick_rdo(), Some("[1] F 5.0V@3.0A"));
        assert_eq!(rdo.pdo().unwrap().field(), "PDO 1");
    }

    #[test]
    fn a_battery_request_summarises_the_pdo_voltage_range() {
        // 0x5901903C: battery PDO, 20 V max, 5 V min, 15 W.
        let pdo = parse_pdo(
            &bits(&[0x3C, 0x90, 0x01, 0x59], Order::Little),
            (0, 31),
            "PDO 2",
            false,
        )
        .unwrap();
        // 0x2000F03C: object position 2, operating 15 W, max 15 W.
        let raw = bits(&[0x3C, 0xF0, 0x00, 0x20], Order::Little);
        let rdo = parse_rdo(&raw, (0, 31), "RDO", pdo, false).unwrap();

        assert_eq!(
            rdo.get("Operating Power").unwrap().value().as_str(),
            Some("15.0W")
        );
        assert_eq!(rdo.quick_rdo(), Some("[2] B 5.0-20.0V@15.0W"));
    }

    #[test]
    fn epr_positions_take_the_e_prefix() {
        let pdo = pdo_of([0x2C, 0x91, 0x01, 0x08], "PDO 8");
        // 0x8004B12C: object position 8.
        let raw = bits(&[0x2C, 0xB1, 0x04, 0x80], Order::Little);
        let rdo = parse_rdo(&raw, (0, 31), "RDO", pdo, false).unwrap();
        assert!(rdo.quick_rdo().unwrap().starts_with("[8] EF "));
    }

    #[test]
    fn an_unassigned_supply_type_has_no_rdo_layout() {
        let pdo = pdo_of([0x00, 0x00, 0x00, 0xF0], "PDO 1");
        let raw = bits(&[0x00, 0x00, 0x00, 0x10], Order::Little);
        assert!(matches!(
            parse_rdo(&raw, (0, 31), "RDO", pdo, false),
            Err(ParseError::Unsupported { .. })
        ));
    }

    /// The layout comes from the classification, not from the printed text — so a
    /// Sink PDO, which carries no classification, names no layout either.
    #[test]
    fn a_sink_pdo_names_no_rdo_layout() {
        let sink = crate::pdo::parse_sink_pdo(
            &bits(&[0x2C, 0x91, 0x01, 0x00], Order::Little),
            (0, 31),
            "PDO 1",
            false,
        )
        .unwrap();
        let raw = bits(&[0x2C, 0xB1, 0x04, 0x10], Order::Little);
        assert!(matches!(
            parse_rdo(&raw, (0, 31), "RDO", sink, false),
            Err(ParseError::Unsupported { .. })
        ));
    }

    #[test]
    fn drops_only_a_trailing_unit_letter() {
        assert_eq!(drop_unit("5.0V"), "5.0");
        assert_eq!(drop_unit("15.5W"), "15.5");
        assert_eq!(drop_unit("5.0"), "5.0");
    }

    /// A short object used to decode anyway: the trailing current fields read from
    /// whatever bits were left, so `Maximum Operating Current` came out as a
    /// plausible number derived from two bits instead of ten.
    #[test]
    fn a_truncated_rdo_is_an_error() {
        let pdo = pdo_of([0x2C, 0x91, 0x01, 0x08], "PDO 1");
        let full = bits(&[0x2C, 0xB1, 0x04, 0x10], Order::Little);

        for len in [0, 8, 16, 24, 31] {
            let short = &full[..len];
            assert!(
                matches!(
                    parse_rdo(short, (0, 31), "RDO", pdo.clone(), false),
                    Err(ParseError::Truncated { field: "RDO" })
                ),
                "{len} bits should be truncated, not decoded"
            );
        }

        assert!(parse_rdo(&full, (0, 31), "RDO", pdo, false).is_ok());
    }
}
