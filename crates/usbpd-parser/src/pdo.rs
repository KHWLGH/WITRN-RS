//! Power Data Objects — the capabilities a Source advertises, and the Sink mirror
//! of each.

use std::borrow::Cow;

use crate::bits::{flag, num, py_float, require_object, sl};
use crate::error::Result;
use crate::metadata::{Metadata, SupplyType, Value};

/// Dispatch a 32-bit Source PDO on its Supply Type (and APDO Type) bits.
///
/// The resulting node carries a [`SupplyType`] alongside the printed `Supply Type`
/// text, so an RDO requesting it can pick its layout from the classification rather
/// than from the wording.
pub(crate) fn parse_pdo(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    prop: bool,
) -> Result<Metadata> {
    require_object(raw, "PDO")?;
    let (pdo, supply) = match (sl(raw, 0, 2), sl(raw, 2, 4)) {
        ("00", _) => (fixed(raw, bit_loc, field)?, SupplyType::Fixed),
        ("01", _) => (battery(raw, bit_loc, field)?, SupplyType::Battery),
        ("10", _) => (variable(raw, bit_loc, field)?, SupplyType::Variable),
        ("11", "00") => (pps(raw, bit_loc, field, prop)?, SupplyType::Pps),
        ("11", "01") => (epr_avs(raw, bit_loc, field)?, SupplyType::EprAvs),
        ("11", "10") => (spr_avs(raw, bit_loc, field)?, SupplyType::SprAvs),
        _ => (
            reserved_apdo(raw, bit_loc, field)?,
            SupplyType::UnassignedApdo,
        ),
    };
    Ok(pdo.with_supply(supply))
}

/// Dispatch a 32-bit Sink PDO on its Supply Type (and APDO Type) bits.
pub(crate) fn parse_sink_pdo(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    prop: bool,
) -> Result<Metadata> {
    require_object(raw, "PDO")?;
    match (sl(raw, 0, 2), sl(raw, 2, 4)) {
        ("00", _) => fixed_sink(raw, bit_loc, field),
        ("01", _) => battery_sink(raw, bit_loc, field),
        ("10", _) => variable_sink(raw, bit_loc, field),
        ("11", "00") => pps_sink(raw, bit_loc, field, prop),
        ("11", "01") => epr_avs_sink(raw, bit_loc, field),
        ("11", "10") => spr_avs_sink(raw, bit_loc, field),
        _ => reserved_apdo(raw, bit_loc, field),
    }
}

/// The trailing object position of a `"PDO 12"`-style field name.
///
/// `None` for names that do not end in a number, such as `"Copy of PDO"`.
fn object_position(field: &str) -> Option<u64> {
    field.rsplit(' ').next()?.parse().ok()
}

/// Whether a PDO sits in an EPR object position (8..=13), which decides the `E`
/// prefix of its quick summary.
///
/// Falls back to "does it exceed the SPR ceiling of 20 V" when the field name
/// carries no position.
fn is_epr(field: &str, volts_if_unnamed: f64) -> bool {
    match object_position(field) {
        Some(pos) => pos >= 8,
        None => volts_if_unnamed > 20.0,
    }
}

fn volts_20(raw: &str, a: usize, b: usize, f: &'static str) -> Result<f64> {
    Ok(num(sl(raw, a, b), f)? as f64 / 20.0)
}

fn volts_10(raw: &str, a: usize, b: usize, f: &'static str) -> Result<f64> {
    Ok(num(sl(raw, a, b), f)? as f64 / 10.0)
}

fn amps_100(raw: &str, a: usize, b: usize, f: &'static str) -> Result<f64> {
    Ok(num(sl(raw, a, b), f)? as f64 / 100.0)
}

fn amps_20(raw: &str, a: usize, b: usize, f: &'static str) -> Result<f64> {
    Ok(num(sl(raw, a, b), f)? as f64 / 20.0)
}

fn watts_4(raw: &str, a: usize, b: usize, f: &'static str) -> Result<f64> {
    Ok(num(sl(raw, a, b), f)? as f64 / 4.0)
}

// ---------------------------------------------------------------- Fixed Supply

const FPDO: &str = "FPDO";

fn fixed(raw: &str, bit_loc: (u32, u32), field: impl Into<Cow<'static, str>>) -> Result<Metadata> {
    let field = field.into();
    let voltage = volts_20(raw, 12, 22, FPDO)?;
    let current = amps_100(raw, 22, 32, FPDO)?;

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "FPDO"),
        Metadata::new(
            sl(raw, 2, 3),
            (29, 29),
            "Dual-Role Power",
            flag(sl(raw, 2, 3), FPDO)?,
        ),
        Metadata::new(
            sl(raw, 3, 4),
            (28, 28),
            "USB Suspend Supported",
            flag(sl(raw, 3, 4), FPDO)?,
        ),
        Metadata::new(
            sl(raw, 4, 5),
            (27, 27),
            "Unconstrained Power",
            flag(sl(raw, 4, 5), FPDO)?,
        ),
        Metadata::new(
            sl(raw, 5, 6),
            (26, 26),
            "USB Communications Capable",
            flag(sl(raw, 5, 6), FPDO)?,
        ),
        Metadata::new(
            sl(raw, 6, 7),
            (25, 25),
            "Dual-Role Data",
            flag(sl(raw, 6, 7), FPDO)?,
        ),
        Metadata::new(
            sl(raw, 7, 8),
            (24, 24),
            "Unchunked Extended Messages Supported",
            flag(sl(raw, 7, 8), FPDO)?,
        ),
        Metadata::new(
            sl(raw, 8, 9),
            (23, 23),
            "EPR Capable",
            flag(sl(raw, 8, 9), FPDO)?,
        ),
        Metadata::reserved(sl(raw, 9, 10), (22, 22)),
        Metadata::new(sl(raw, 10, 12), (21, 20), "Peak Current", sl(raw, 10, 12)),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Voltage",
            format!("{}V", py_float(voltage)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Current",
            format!("{}A", py_float(current)),
        ),
    ];

    let prefix = if is_epr(&field, voltage) { "EF" } else { "F" };
    let quick = format!("{prefix} {}V@{}A", py_float(voltage), py_float(current));
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)).with_quick_pdo(quick))
}

fn fixed_sink(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    const F: &str = "FPDO Sink";

    let frs = match sl(raw, 7, 9) {
        "00" => "Not Supported",
        "01" => "Default USB Port",
        "10" => "1.5A@5V",
        "11" => "3A@5V",
        _ => "Reserved",
    };

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "FPDO Sink"),
        Metadata::new(
            sl(raw, 2, 3),
            (29, 29),
            "Dual-Role Power",
            flag(sl(raw, 2, 3), F)?,
        ),
        Metadata::new(
            sl(raw, 3, 4),
            (28, 28),
            "Higher Capability",
            flag(sl(raw, 3, 4), F)?,
        ),
        Metadata::new(
            sl(raw, 4, 5),
            (27, 27),
            "Unconstrained Power",
            flag(sl(raw, 4, 5), F)?,
        ),
        Metadata::new(
            sl(raw, 5, 6),
            (26, 26),
            "USB Communications Capable",
            flag(sl(raw, 5, 6), F)?,
        ),
        Metadata::new(
            sl(raw, 6, 7),
            (25, 25),
            "Dual-Role Data",
            flag(sl(raw, 6, 7), F)?,
        ),
        Metadata::new(
            sl(raw, 7, 9),
            (24, 23),
            "Fast Role Swap required USB Type-C Current",
            frs,
        ),
        Metadata::reserved(sl(raw, 9, 12), (22, 20)),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Voltage",
            format!("{}V", py_float(volts_20(raw, 12, 22, F)?)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Operational Current",
            format!("{}A", py_float(amps_100(raw, 22, 32, F)?)),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

// -------------------------------------------------------------- Battery Supply

const BPDO: &str = "BPDO";

fn battery(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    let field = field.into();
    let max_v = volts_20(raw, 2, 12, BPDO)?;
    let min_v = volts_20(raw, 12, 22, BPDO)?;
    let power = watts_4(raw, 22, 32, BPDO)?;

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "BPDO"),
        Metadata::new(
            sl(raw, 2, 12),
            (29, 20),
            "Maximum Voltage",
            format!("{}V", py_float(max_v)),
        ),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Minimum Voltage",
            format!("{}V", py_float(min_v)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Allowable Power",
            format!("{}W", py_float(power)),
        ),
    ];

    let prefix = if is_epr(&field, max_v) { "EB" } else { "B" };
    let quick = format!(
        "{prefix} {}-{}V@{}W",
        py_float(min_v),
        py_float(max_v),
        py_float(power)
    );
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)).with_quick_pdo(quick))
}

fn battery_sink(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    const F: &str = "BPDO Sink";

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "BPDO Sink"),
        Metadata::new(
            sl(raw, 2, 12),
            (29, 20),
            "Maximum Voltage",
            format!("{}V", py_float(volts_20(raw, 2, 12, F)?)),
        ),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Minimum Voltage",
            format!("{}V", py_float(volts_20(raw, 12, 22, F)?)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Operational Power",
            format!("{}W", py_float(watts_4(raw, 22, 32, F)?)),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

// ------------------------------------------------------------- Variable Supply

const VPDO: &str = "VPDO";

fn variable(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    let field = field.into();
    let max_v = volts_20(raw, 2, 12, VPDO)?;
    let min_v = volts_20(raw, 12, 22, VPDO)?;
    let current = amps_100(raw, 22, 32, VPDO)?;

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "VPDO"),
        Metadata::new(
            sl(raw, 2, 12),
            (29, 20),
            "Maximum Voltage",
            format!("{}V", py_float(max_v)),
        ),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Minimum Voltage",
            format!("{}V", py_float(min_v)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Current",
            format!("{}A", py_float(current)),
        ),
    ];

    let prefix = if is_epr(&field, min_v) { "EV" } else { "V" };
    let quick = format!(
        "{prefix} {}-{}V@{}A",
        py_float(min_v),
        py_float(max_v),
        py_float(current)
    );
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)).with_quick_pdo(quick))
}

fn variable_sink(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    const F: &str = "VPDO Sink";

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "VPDO Sink"),
        Metadata::new(
            sl(raw, 2, 12),
            (29, 20),
            "Maximum Voltage",
            format!("{}V", py_float(volts_20(raw, 2, 12, F)?)),
        ),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Minimum Voltage",
            format!("{}V", py_float(volts_20(raw, 12, 22, F)?)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Operational Current",
            format!("{}A", py_float(amps_100(raw, 22, 32, F)?)),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

// ------------------------------------------------- Augmented Supply: SPR PPS

const PPS: &str = "PPS APDO";

/// SPR Programmable Power Supply.
///
/// `prop` selects WITRN's proprietary widening of the voltage and current fields
/// into the bits the spec reserves, which is what their hardware reports.
fn pps(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    prop: bool,
) -> Result<Metadata> {
    let mut fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "SPR PPS"),
        Metadata::new(
            sl(raw, 4, 5),
            (27, 27),
            "PPS Power Limited",
            flag(sl(raw, 4, 5), PPS)?,
        ),
    ];

    let (max_v, min_v, current) = if prop {
        let (max_v, min_v, current) = (
            volts_10(raw, 5, 15, PPS)?,
            volts_10(raw, 15, 24, PPS)?,
            amps_20(raw, 24, 32, PPS)?,
        );
        fields.extend([
            Metadata::new(
                sl(raw, 5, 15),
                (26, 17),
                "Maximum Voltage",
                format!("{}V", py_float(max_v)),
            ),
            Metadata::new(
                sl(raw, 15, 24),
                (16, 8),
                "Minimum Voltage",
                format!("{}V", py_float(min_v)),
            ),
            Metadata::new(
                sl(raw, 24, 32),
                (7, 0),
                "Maximum Current",
                format!("{}A", py_float(current)),
            ),
        ]);
        (max_v, min_v, current)
    } else {
        let (max_v, min_v, current) = (
            volts_10(raw, 7, 15, PPS)?,
            volts_10(raw, 16, 24, PPS)?,
            amps_20(raw, 25, 32, PPS)?,
        );
        fields.extend([
            Metadata::reserved(sl(raw, 5, 7), (26, 25)),
            Metadata::new(
                sl(raw, 7, 15),
                (24, 17),
                "Maximum Voltage",
                format!("{}V", py_float(max_v)),
            ),
            Metadata::reserved(sl(raw, 15, 16), (16, 16)),
            Metadata::new(
                sl(raw, 16, 24),
                (15, 8),
                "Minimum Voltage",
                format!("{}V", py_float(min_v)),
            ),
            Metadata::reserved(sl(raw, 24, 25), (7, 7)),
            Metadata::new(
                sl(raw, 25, 32),
                (6, 0),
                "Maximum Current",
                format!("{}A", py_float(current)),
            ),
        ]);
        (max_v, min_v, current)
    };

    let quick = format!(
        "P {}-{}V@{}A",
        py_float(min_v),
        py_float(max_v),
        py_float(current)
    );
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)).with_quick_pdo(quick))
}

fn pps_sink(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
    prop: bool,
) -> Result<Metadata> {
    const F: &str = "PPS APDO Sink";

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO Sink"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "SPR PPS"),
    ];

    if prop {
        fields.extend([
            Metadata::new(
                sl(raw, 4, 15),
                (27, 17),
                "Maximum Voltage",
                format!("{}V", py_float(volts_10(raw, 4, 15, F)?)),
            ),
            Metadata::new(
                sl(raw, 15, 24),
                (16, 8),
                "Minimum Voltage",
                format!("{}V", py_float(volts_10(raw, 15, 24, F)?)),
            ),
            Metadata::new(
                sl(raw, 24, 32),
                (7, 0),
                "Maximum Current",
                format!("{}A", py_float(amps_20(raw, 24, 32, F)?)),
            ),
        ]);
    } else {
        fields.extend([
            Metadata::reserved(sl(raw, 4, 7), (27, 25)),
            Metadata::new(
                sl(raw, 7, 15),
                (24, 17),
                "Maximum Voltage",
                format!("{}V", py_float(volts_10(raw, 7, 15, F)?)),
            ),
            Metadata::reserved(sl(raw, 15, 16), (16, 16)),
            Metadata::new(
                sl(raw, 16, 24),
                (15, 8),
                "Minimum Voltage",
                format!("{}V", py_float(volts_10(raw, 16, 24, F)?)),
            ),
            Metadata::reserved(sl(raw, 24, 25), (7, 7)),
            Metadata::new(
                sl(raw, 25, 32),
                (6, 0),
                "Maximum Current",
                format!("{}A", py_float(amps_20(raw, 25, 32, F)?)),
            ),
        ]);
    }

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

// ------------------------------------------------- Augmented Supply: EPR AVS

const EPR_AVS: &str = "EPR AVS APDO";

fn epr_avs(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    let max_v = volts_10(raw, 6, 15, EPR_AVS)?;
    let min_v = volts_10(raw, 16, 24, EPR_AVS)?;
    let pdp = num(sl(raw, 24, 32), EPR_AVS)?;

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "EPR AVS"),
        Metadata::new(sl(raw, 4, 6), (27, 26), "Peak Current", sl(raw, 4, 6)),
        Metadata::new(
            sl(raw, 6, 15),
            (25, 17),
            "Maximum Voltage",
            format!("{}V", py_float(max_v)),
        ),
        Metadata::reserved(sl(raw, 15, 16), (16, 16)),
        Metadata::new(
            sl(raw, 16, 24),
            (15, 8),
            "Minimum Voltage",
            format!("{}V", py_float(min_v)),
        ),
        Metadata::new(sl(raw, 24, 32), (7, 0), "PDP", format!("{pdp}W")),
    ];

    let quick = format!("EA {}-{}V@{pdp}W", py_float(min_v), py_float(max_v));
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)).with_quick_pdo(quick))
}

fn epr_avs_sink(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    const F: &str = "EPR AVS APDO Sink";

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO Sink"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "EPR AVS"),
        Metadata::reserved(sl(raw, 4, 6), (27, 26)),
        Metadata::new(
            sl(raw, 6, 15),
            (25, 17),
            "Maximum Voltage",
            format!("{}V", py_float(volts_10(raw, 6, 15, F)?)),
        ),
        Metadata::reserved(sl(raw, 15, 16), (16, 16)),
        Metadata::new(
            sl(raw, 16, 24),
            (15, 8),
            "Minimum Voltage",
            format!("{}V", py_float(volts_10(raw, 16, 24, F)?)),
        ),
        Metadata::new(
            sl(raw, 24, 32),
            (7, 0),
            "PDP",
            format!("{}W", num(sl(raw, 24, 32), F)?),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

// ------------------------------------------------- Augmented Supply: SPR AVS

const SPR_AVS: &str = "SPR AVS APDO";

fn spr_avs(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    let i15 = amps_100(raw, 12, 22, SPR_AVS)?;
    let i20 = amps_100(raw, 22, 32, SPR_AVS)?;

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "SPR AVS"),
        Metadata::new(sl(raw, 4, 6), (27, 26), "Peak Current", sl(raw, 4, 6)),
        Metadata::reserved(sl(raw, 6, 12), (25, 20)),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Maximum Current 15V",
            format!("{}A", py_float(i15)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Current 20V",
            format!("{}A", py_float(i20)),
        ),
    ];

    let quick = format!("SA 9-15V@{}A 15-20V@{}A", py_float(i15), py_float(i20));
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)).with_quick_pdo(quick))
}

fn spr_avs_sink(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    const F: &str = "SPR AVS APDO Sink";

    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO Sink"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "SPR AVS"),
        Metadata::reserved(sl(raw, 4, 12), (27, 20)),
        Metadata::new(
            sl(raw, 12, 22),
            (19, 10),
            "Maximum Current 15V",
            format!("{}A", py_float(amps_100(raw, 12, 22, F)?)),
        ),
        Metadata::new(
            sl(raw, 22, 32),
            (9, 0),
            "Maximum Current 20V",
            format!("{}A", py_float(amps_100(raw, 22, 32, F)?)),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

/// APDO Type `11`, which the spec has not assigned.
///
/// The original raised `TypeError` here and discarded the whole message; this
/// reports the object for what it is.
fn reserved_apdo(
    raw: &str,
    bit_loc: (u32, u32),
    field: impl Into<Cow<'static, str>>,
) -> Result<Metadata> {
    let fields = vec![
        Metadata::new(sl(raw, 0, 2), (31, 30), "Supply Type", "APDO"),
        Metadata::new(sl(raw, 2, 4), (29, 28), "APDO Type", "Reserved"),
        Metadata::reserved(sl(raw, 4, 32), (27, 0)),
    ];
    Ok(Metadata::new(raw, bit_loc, field, Value::List(fields)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::{bits, Order};

    fn pdo_of(bytes: [u8; 4], name: &'static str) -> Metadata {
        let raw = bits(&bytes, Order::Little);
        parse_pdo(&raw, (0, 31), name, false).unwrap()
    }

    #[test]
    fn decodes_a_5v_3a_fixed_pdo() {
        // 0x0801912C: fixed, 5.0 V, 3.0 A.
        let pdo = pdo_of([0x2C, 0x91, 0x01, 0x08], "PDO 1");
        assert_eq!(
            pdo.get("Supply Type").unwrap().value().as_str(),
            Some("FPDO")
        );
        assert_eq!(pdo.get("Voltage").unwrap().value().as_str(), Some("5.0V"));
        assert_eq!(
            pdo.get("Maximum Current").unwrap().value().as_str(),
            Some("3.0A")
        );
        assert_eq!(pdo.quick_pdo(), Some("F 5.0V@3.0A"));
    }

    #[test]
    fn epr_object_positions_take_the_e_prefix_past_position_nine() {
        // The original read only the last character of the name, so "PDO 10".."PDO 13"
        // lost the prefix.
        for (name, expected) in [
            ("PDO 7", "F"),
            ("PDO 8", "EF"),
            ("PDO 9", "EF"),
            ("PDO 10", "EF"),
            ("PDO 13", "EF"),
        ] {
            let raw = bits(&[0x2C, 0x91, 0x01, 0x08], Order::Little);
            let pdo = parse_pdo(&raw, (0, 31), name.to_owned(), false).unwrap();
            let quick = pdo.quick_pdo().unwrap();
            assert!(
                quick.starts_with(&format!("{expected} ")),
                "{name} produced {quick}"
            );
        }
    }

    #[test]
    fn an_unnamed_pdo_falls_back_to_the_spr_voltage_ceiling() {
        // 28 V / 3 A fixed with no object position in the name reads as EPR.
        let raw = bits(&[0x2C, 0xC1, 0x08, 0x00], Order::Little);
        let pdo = parse_pdo(&raw, (0, 31), "Copy of PDO", false).unwrap();
        assert_eq!(pdo.get("Voltage").unwrap().value().as_str(), Some("28.0V"));
        assert!(pdo.quick_pdo().unwrap().starts_with("EF "));
    }

    #[test]
    fn variable_pdo_summarises_low_voltage_first() {
        // 0x99019064: variable, 20 V max / 5 V min, 1.00 A.
        let raw = bits(&[0x64, 0x90, 0x01, 0x99], Order::Little);
        let pdo = parse_pdo(&raw, (0, 31), "PDO 2", false).unwrap();
        assert_eq!(
            pdo.get("Maximum Voltage").unwrap().value().as_str(),
            Some("20.0V")
        );
        assert_eq!(
            pdo.get("Minimum Voltage").unwrap().value().as_str(),
            Some("5.0V")
        );
        assert_eq!(pdo.quick_pdo(), Some("V 5.0-20.0V@1.0A"));
    }

    #[test]
    fn proprietary_pps_widens_the_reserved_bits() {
        let raw = bits(&[0x64, 0x32, 0x90, 0xC0], Order::Little);
        let plain = parse_pdo(&raw, (0, 31), "PDO 3", false).unwrap();
        let prop = parse_pdo(&raw, (0, 31), "PDO 3", true).unwrap();
        assert_eq!(
            plain.get("APDO Type").unwrap().value().as_str(),
            Some("SPR PPS")
        );
        assert_eq!(
            prop.get("APDO Type").unwrap().value().as_str(),
            Some("SPR PPS")
        );
        // The proprietary layout has no Reserved padding between the voltage fields.
        assert_eq!(plain.children().unwrap().len(), 9);
        assert_eq!(prop.children().unwrap().len(), 6);
    }

    #[test]
    fn an_unassigned_apdo_type_still_parses() {
        let raw = bits(&[0x00, 0x00, 0x00, 0xF0], Order::Little);
        let pdo = parse_pdo(&raw, (0, 31), "PDO 4", false).unwrap();
        assert_eq!(
            pdo.get("APDO Type").unwrap().value().as_str(),
            Some("Reserved")
        );
    }

    #[test]
    fn sink_pdos_report_operational_rather_than_maximum_ratings() {
        let raw = bits(&[0x2C, 0x91, 0x01, 0x00], Order::Little);
        let pdo = parse_sink_pdo(&raw, (0, 31), "PDO 1", false).unwrap();
        assert_eq!(
            pdo.get("Supply Type").unwrap().value().as_str(),
            Some("FPDO Sink")
        );
        assert!(pdo.get("Operational Current").is_some());
        assert!(pdo.quick_pdo().is_none());
    }

    #[test]
    fn a_truncated_pdo_is_an_error() {
        assert!(parse_pdo("0000", (0, 31), "PDO 1", false).is_err());
    }

    /// An RDO's field layout is chosen from this, not from the printed `Supply Type`,
    /// so the two must not be allowed to drift apart.
    #[test]
    fn every_source_pdo_carries_its_classification() {
        for (bytes, text, supply) in [
            ([0x2C, 0x91, 0x01, 0x08], "FPDO", SupplyType::Fixed),
            ([0x3C, 0x90, 0x01, 0x59], "BPDO", SupplyType::Battery),
            ([0x64, 0x90, 0x01, 0x99], "VPDO", SupplyType::Variable),
            ([0x64, 0x32, 0x90, 0xC0], "APDO", SupplyType::Pps),
            ([0x00, 0x00, 0x00, 0xF0], "APDO", SupplyType::UnassignedApdo),
        ] {
            let pdo = pdo_of(bytes, "PDO 1");
            assert_eq!(pdo.supply_type(), Some(supply), "{supply:?}");
            assert_eq!(
                pdo.get("Supply Type").unwrap().value().as_str(),
                Some(text),
                "the printed text changed for {supply:?}"
            );
        }
    }

    /// A Sink PDO is not something an RDO can request against, so it names no layout.
    #[test]
    fn sink_pdos_carry_no_classification() {
        let raw = bits(&[0x2C, 0x91, 0x01, 0x00], Order::Little);
        let pdo = parse_sink_pdo(&raw, (0, 31), "PDO 1", false).unwrap();
        assert_eq!(pdo.supply_type(), None);
    }
}
