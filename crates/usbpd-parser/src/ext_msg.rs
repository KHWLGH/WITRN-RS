//! Extended Message bodies — the `Data Block` of an extended PD message, including
//! the ones that arrive in chunks.

use crate::bits::{bits, bsl, flag, hex_upper, num, py_float, sl, Order};
use crate::context::Ctx;
use crate::error::{ParseError, Result};
use crate::header::needs_previous_chunk;
use crate::metadata::{Metadata, Raw, Value};
use crate::pdo::{parse_pdo, parse_sink_pdo};
use crate::vdo;

/// Decode the body of an Extended Message.
///
/// Every extended message type has a body, so unlike [`data_msg::parse`] this always
/// produces one — an unassigned type falls back to a hex `Data Block`.
pub(crate) fn parse(
    message_type: &str,
    data: &[u8],
    bit_loc: (u32, u32),
    ctx: &Ctx<'_>,
) -> Result<Metadata> {
    match message_type {
        "Source_Capabilities_Extended" => source_capabilities_extended(data, bit_loc),
        "Status" => status(data, bit_loc, ctx),
        "Get_Battery_Cap" => battery_ref(data, bit_loc, "GBCDB", "Battery Cap Ref"),
        "Get_Battery_Status" => battery_ref(data, bit_loc, "GBSDB", "Battery Status Ref"),
        "Battery_Capabilities" => battery_capabilities(data, bit_loc),
        "Get_Manufacturer_Info" => get_manufacturer_info(data, bit_loc),
        "Manufacturer_Info" => manufacturer_info(data, bit_loc, ctx),
        "Security_Request" => blob(data, bit_loc, ctx, "SRQDB"),
        "Security_Response" => blob(data, bit_loc, ctx, "SRPDB"),
        "Firmware_Update_Request" => blob(data, bit_loc, ctx, "FRQDB"),
        "Firmware_Update_Response" => blob(data, bit_loc, ctx, "FRPDB"),
        "PPS_Status" => pps_status(data, bit_loc),
        "Country_Info" => country_info(data, bit_loc, ctx),
        "Country_Codes" => country_codes(data, bit_loc, ctx),
        "Sink_Capabilities_Extended" => sink_capabilities_extended(data, bit_loc),
        "Extended_Control" => extended_control(data, bit_loc),
        "EPR_Source_Capabilities" => epr_capabilities(data, bit_loc, ctx, false),
        "EPR_Sink_Capabilities" => epr_capabilities(data, bit_loc, ctx, true),
        "Vendor_Defined_Extended" => vendor_defined_extended(data, bit_loc, ctx),
        _ => Ok(reserved_block(data, bit_loc)),
    }
}

/// A body the spec has not assigned, reported as raw hex.
pub(crate) fn reserved_block(data: &[u8], bit_loc: (u32, u32)) -> Metadata {
    Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        "Data Block",
        format!("0x{}", hex_upper(data)),
    )
}

/// Bits of bytes `a..b`, MSB-first — one logical little-endian field.
fn f(data: &[u8], a: usize, b: usize) -> String {
    bits(bsl(data, a, b), Order::Little)
}

/// Bit range covered by bytes `a..b`.
///
/// An empty range — which a `Data Size` of zero produces — collapses to its start
/// rather than wrapping around: `b * 8 - 1` underflows for `b == 0`, and the bodies
/// below take `b` straight from the wire.
fn loc(a: usize, b: usize) -> (u32, u32) {
    let (start, end) = (a as u32 * 8, b as u32 * 8);
    (start, end.saturating_sub(1).max(start))
}

fn byte(data: &[u8], i: usize, field: &'static str) -> Result<u8> {
    data.get(i).copied().ok_or(ParseError::Truncated { field })
}

/// `Data Size` for a body that cannot be shorter than its own fixed header.
///
/// The wire value is a 9-bit field, so zero is encodable; a body whose fixed part
/// alone is `min` bytes long cannot be decoded from fewer, and saying so here keeps
/// the nonsense out of the byte ranges below.
fn payload_size(ctx: &Ctx<'_>, field: &'static str, min: usize) -> Result<usize> {
    let size = ctx.data_size(field)?;
    if size < min {
        return Err(ParseError::Truncated { field });
    }
    Ok(size)
}

/// `0x…` of bytes `a..b` in little-endian value order, as the original printed
/// header identifiers.
fn hex_le(data: &[u8], a: usize, b: usize) -> String {
    format!("0x{}", crate::bits::hex_rev_upper(bsl(data, a, b)))
}

fn ascii(data: &[u8], field: &'static str) -> Result<String> {
    if data.is_ascii() {
        Ok(String::from_utf8_lossy(data).into_owned())
    } else {
        Err(ParseError::NotAscii { field })
    }
}

/// `0..=3` are fixed batteries, `4..=7` hot-swappable, the rest unassigned.
fn battery_reference(byte: u8) -> String {
    match byte {
        0..=3 => format!("Fixed Battery {byte}"),
        4..=7 => format!("Hot Swappable Battery {}", byte - 4),
        _ => "Reserved".to_owned(),
    }
}

/// The 16-bit "peak current"/"load characteristics" shape shared by SCEDB and SKEDB.
fn overload_profile(
    raw: &str,
    field: &'static str,
    overload_name: &'static str,
) -> Result<Vec<Metadata>> {
    Ok(vec![
        Metadata::new(
            sl(raw, 11, 16),
            (4, 0),
            overload_name,
            format!("{}%", num(sl(raw, 11, 16), field)?.min(25) * 10),
        ),
        Metadata::new(
            sl(raw, 5, 11),
            (10, 5),
            "Overload Period",
            format!("{}ms", num(sl(raw, 5, 11), field)? * 20),
        ),
        Metadata::new(
            sl(raw, 1, 5),
            (14, 11),
            "Duty Cycle",
            format!("{}%", num(sl(raw, 1, 5), field)? * 5),
        ),
        Metadata::new(
            sl(raw, 0, 1),
            (15, 15),
            "VBUS Droop",
            flag(sl(raw, 0, 1), field)?,
        ),
    ])
}

// ------------------------------------------------ Source_Capabilities_Extended

fn source_capabilities_extended(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "SCEDB";

    let vr = f(data, 10, 11);
    let voltage_regulation = vec![
        Metadata::new(
            sl(&vr, 6, 8),
            (1, 0),
            "Load Step Slew Rate",
            match sl(&vr, 6, 8) {
                "00" => "150mA/\u{3bc}s",
                "01" => "500mA/\u{3bc}s",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            sl(&vr, 5, 6),
            (2, 2),
            "Load Step Magnitude",
            if flag(sl(&vr, 5, 6), F)? {
                "90% IoC"
            } else {
                "25% IoC"
            },
        ),
        Metadata::reserved(sl(&vr, 0, 5), (7, 3)),
    ];

    let compliance_raw = f(data, 12, 13);
    let compliance = vec![
        Metadata::new(
            sl(&compliance_raw, 7, 8),
            (0, 0),
            "LPS Compliant",
            flag(sl(&compliance_raw, 7, 8), F)?,
        ),
        Metadata::new(
            sl(&compliance_raw, 6, 7),
            (1, 1),
            "PS1 Compliant",
            flag(sl(&compliance_raw, 6, 7), F)?,
        ),
        Metadata::new(
            sl(&compliance_raw, 5, 6),
            (2, 2),
            "PS2 Compliant",
            flag(sl(&compliance_raw, 5, 6), F)?,
        ),
        Metadata::reserved(sl(&compliance_raw, 0, 5), (7, 3)),
    ];

    let tc = f(data, 13, 14);
    let touch_current = vec![
        Metadata::new(
            sl(&tc, 7, 8),
            (0, 0),
            "Low Touch Current EPS",
            flag(sl(&tc, 7, 8), F)?,
        ),
        Metadata::new(
            sl(&tc, 6, 7),
            (1, 1),
            "Ground Pin Supported",
            flag(sl(&tc, 6, 7), F)?,
        ),
        Metadata::new(
            sl(&tc, 5, 6),
            (2, 2),
            "Ground Pin Intended for Protective Earth",
            flag(sl(&tc, 5, 6), F)?,
        ),
        Metadata::reserved(sl(&tc, 0, 5), (7, 3)),
    ];

    let holdup = byte(data, 11, F)?;

    let mut fields = vec![
        Metadata::new(f(data, 0, 2), loc(0, 2), "VID", hex_le(data, 0, 2)),
        Metadata::new(f(data, 2, 4), loc(2, 4), "PID", hex_le(data, 2, 4)),
        // The original printed bytes 0..2 here, repeating the VID.
        Metadata::new(f(data, 4, 8), loc(4, 8), "XID", hex_le(data, 4, 8)),
        Metadata::new(f(data, 8, 9), loc(8, 9), "FW Version", hex_le(data, 8, 9)),
        Metadata::new(
            f(data, 9, 10),
            loc(9, 10),
            "HW Version",
            hex_le(data, 9, 10),
        ),
        Metadata::new(
            vr,
            loc(10, 11),
            "Voltage Regulation",
            Value::List(voltage_regulation),
        ),
        Metadata::new(
            f(data, 11, 12),
            loc(11, 12),
            "Holdup Time",
            if holdup == 0 {
                "Not Supported".to_owned()
            } else {
                format!("{holdup}ms")
            },
        ),
        Metadata::new(
            compliance_raw,
            loc(12, 13),
            "Compliance",
            Value::List(compliance),
        ),
        Metadata::new(tc, loc(13, 14), "Touch Current", Value::List(touch_current)),
    ];

    for i in 0..3 {
        let (a, b) = (14 + i * 2, 16 + i * 2);
        let raw = f(data, a, b);
        let peak = overload_profile(&raw, F, "Percentage Overload")?;
        fields.push(Metadata::new(
            raw,
            loc(a, b),
            format!("Peak Current{}", i + 1),
            Value::List(peak),
        ));
    }

    fields.push(Metadata::new(
        f(data, 20, 21),
        loc(20, 21),
        "Touch Temp",
        match byte(data, 20, F)? {
            0 => "[IEC 60950-1]",
            1 => "[IEC 62368-1] TS1",
            2 => "[IEC 62368-1] TS2",
            _ => "Reserved",
        },
    ));

    let si = f(data, 21, 22);
    let external = flag(sl(&si, 7, 8), F)?;
    let mut source_inputs = vec![Metadata::new(
        sl(&si, 7, 8),
        (0, 0),
        "External Power Supply",
        external,
    )];
    source_inputs.push(if external {
        Metadata::new(
            sl(&si, 6, 7),
            (1, 1),
            "Constrained",
            !flag(sl(&si, 6, 7), F)?,
        )
    } else {
        Metadata::reserved(sl(&si, 6, 7), (1, 1))
    });
    source_inputs.push(Metadata::new(
        sl(&si, 5, 6),
        (2, 2),
        "Internal Battery",
        flag(sl(&si, 5, 6), F)?,
    ));
    source_inputs.push(Metadata::reserved(sl(&si, 0, 5), (7, 3)));

    fields.extend([
        Metadata::new(si, loc(21, 22), "Source Inputs", Value::List(source_inputs)),
        Metadata::new(
            f(data, 22, 23),
            loc(22, 23),
            "Number of Batteries/Battery Slots",
            f(data, 22, 23),
        ),
        Metadata::new(
            f(data, 23, 24),
            loc(23, 24),
            "SPR Source PDP Rating",
            format!("{}W", byte(data, 23, F)?),
        ),
        Metadata::new(
            f(data, 24, 25),
            loc(24, 25),
            "EPR Source PDP Rating",
            format!("{}W", byte(data, 24, F)?),
        ),
    ]);

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// -------------------------------------------------------------------- Status

fn status(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "SDB";

    let internal_temp = byte(data, 0, F)?;
    let mut fields = vec![Metadata::new(
        f(data, 0, 1),
        loc(0, 1),
        "Internal Temp",
        match internal_temp {
            0 => "Not Support".to_owned(),
            1 => "Less than 2\u{b0}C".to_owned(),
            t => format!("{t}\u{b0}C"),
        },
    )];

    let pi = f(data, 1, 2);
    let external = flag(sl(&pi, 6, 7), F)?;
    let mut present_input = vec![
        Metadata::reserved(sl(&pi, 7, 8), (0, 0)),
        Metadata::new(sl(&pi, 6, 7), (1, 1), "External Power", external),
    ];
    present_input.push(if external {
        Metadata::new(
            sl(&pi, 5, 6),
            (2, 2),
            "External Power Type",
            if flag(sl(&pi, 5, 6), F)? { "AC" } else { "DC" },
        )
    } else {
        Metadata::reserved(sl(&pi, 5, 6), (2, 2))
    });
    let from_battery = flag(sl(&pi, 4, 5), F)?;
    present_input.extend([
        Metadata::new(
            sl(&pi, 4, 5),
            (3, 3),
            "Internal Power from Battery",
            from_battery,
        ),
        Metadata::new(
            sl(&pi, 3, 4),
            (4, 4),
            "Internal Power from non-Battery",
            flag(sl(&pi, 3, 4), F)?,
        ),
        Metadata::reserved(sl(&pi, 0, 3), (7, 5)),
    ]);

    fields.push(Metadata::new(
        pi,
        loc(1, 2),
        "Present Input",
        Value::List(present_input),
    ));

    fields.push(if from_battery {
        Metadata::new(
            f(data, 2, 3),
            loc(2, 3),
            "Present Battery Input",
            f(data, 2, 3),
        )
    } else {
        Metadata::reserved(f(data, 2, 3), loc(2, 3))
    });

    // The CL/CV flag only means anything while a PPS supply is in force, which is
    // what the RDO on record tells us.
    let in_pps = ctx
        .last_rdo
        .ok_or(ParseError::MissingContext {
            which: "last_rdo",
            field: F,
        })?
        .get("Data Objects")
        .and_then(|m| m.get("RDO"))
        .and_then(|rdo| rdo.pdo())
        .map(|pdo| sl(pdo.raw().as_str(), 0, 4) == "1100")
        .ok_or(ParseError::MissingContext {
            which: "last_rdo",
            field: F,
        })?;

    let ef = f(data, 3, 4);
    let mut event_flags = vec![
        Metadata::reserved(sl(&ef, 7, 8), (0, 0)),
        Metadata::new(sl(&ef, 6, 7), (1, 1), "OCP Event", flag(sl(&ef, 6, 7), F)?),
        Metadata::new(sl(&ef, 5, 6), (2, 2), "OTP Event", flag(sl(&ef, 5, 6), F)?),
        Metadata::new(sl(&ef, 4, 5), (3, 3), "OVP Event", flag(sl(&ef, 4, 5), F)?),
    ];
    event_flags.push(if in_pps {
        Metadata::new(
            sl(&ef, 3, 4),
            (4, 4),
            "CL/CV Mode",
            if flag(sl(&ef, 3, 4), F)? { "CL" } else { "CV" },
        )
    } else {
        Metadata::reserved(sl(&ef, 3, 4), (4, 4))
    });
    event_flags.push(Metadata::reserved(sl(&ef, 0, 3), (7, 5)));

    fields.extend([
        Metadata::new(ef, loc(3, 4), "Event Flags", Value::List(event_flags)),
        Metadata::new(
            f(data, 4, 5),
            loc(4, 5),
            "Temperature Status",
            match byte(data, 4, F)? {
                0 => "Not Supported",
                1 => "Normal",
                2 => "Warning",
                3 => "Over Temperature",
                _ => "Reserved",
            },
        ),
    ]);

    let ps = f(data, 5, 6);
    let power_status = vec![
        Metadata::reserved(sl(&ps, 7, 8), (0, 0)),
        Metadata::new(
            sl(&ps, 6, 7),
            (1, 1),
            "Cable Supported Current",
            flag(sl(&ps, 6, 7), F)?,
        ),
        Metadata::new(
            sl(&ps, 5, 6),
            (2, 2),
            "Sourcing Other Ports",
            flag(sl(&ps, 5, 6), F)?,
        ),
        Metadata::new(
            sl(&ps, 4, 5),
            (3, 3),
            "Insufficient External Power",
            flag(sl(&ps, 4, 5), F)?,
        ),
        Metadata::new(
            sl(&ps, 3, 4),
            (4, 4),
            "Event Flags in Place",
            flag(sl(&ps, 3, 4), F)?,
        ),
        Metadata::new(
            sl(&ps, 2, 3),
            (5, 5),
            "Temperature",
            flag(sl(&ps, 2, 3), F)?,
        ),
        Metadata::reserved(sl(&ps, 0, 2), (7, 6)),
    ];
    fields.push(Metadata::new(
        ps,
        loc(5, 6),
        "Power Status",
        Value::List(power_status),
    ));

    let psc = f(data, 6, 7);
    let power_state_change = vec![
        Metadata::new(
            sl(&psc, 5, 8),
            (2, 0),
            "New Power State",
            match sl(&psc, 5, 8) {
                "000" => "Status Not Supported",
                "001" => "S0",
                "010" => "Modern Standby",
                "011" => "S3",
                "100" => "S4",
                "101" => "S5",
                "110" => "G3",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            sl(&psc, 2, 5),
            (5, 3),
            "New Power State indicator",
            match sl(&psc, 2, 5) {
                "000" => "Off LED",
                "001" => "On LED",
                "010" => "Blinking LED",
                "011" => "Breathing LED",
                _ => "Reserved",
            },
        ),
        Metadata::reserved(sl(&psc, 0, 2), (7, 6)),
    ];
    fields.push(Metadata::new(
        psc,
        loc(6, 7),
        "Power State Change",
        Value::List(power_state_change),
    ));

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// ---------------------------------------------- Battery and manufacturer info

fn battery_ref(
    data: &[u8],
    bit_loc: (u32, u32),
    block: &'static str,
    field: &'static str,
) -> Result<Metadata> {
    let value = battery_reference(byte(data, 0, block)?);
    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        block,
        Value::List(vec![Metadata::new(f(data, 0, 1), loc(0, 1), field, value)]),
    ))
}

fn battery_capabilities(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "BCDB";

    /// A 16-bit capacity in 0.1 Wh, with the two sentinel values the spec reserves.
    fn capacity(raw: &str, unknown: &'static str) -> Result<Value> {
        Ok(match num(raw, F)? {
            0 => "Battery Not Present".into(),
            0xFFFF => unknown.into(),
            v => format!("{}WH", py_float(v as f64 / 10.0)).into(),
        })
    }

    let battery_type = f(data, 8, 9);
    let fields = vec![
        Metadata::new(f(data, 0, 2), loc(0, 2), "VID", hex_le(data, 0, 2)),
        Metadata::new(f(data, 2, 4), loc(2, 4), "PID", hex_le(data, 2, 4)),
        Metadata::new(
            f(data, 4, 6),
            loc(4, 6),
            "Battery Design Capacity",
            capacity(&f(data, 4, 6), "Design Capacity Unknown")?,
        ),
        Metadata::new(
            f(data, 6, 8),
            loc(6, 8),
            "Battery Last Full Charge Capacity",
            capacity(&f(data, 6, 8), "Battery Last Full Charge Capacity Unknown")?,
        ),
        Metadata::new(
            battery_type.clone(),
            loc(8, 9),
            "Battery Type",
            Value::List(vec![
                Metadata::new(
                    sl(&battery_type, 7, 8),
                    (0, 0),
                    "Invalid Battery Reference",
                    flag(sl(&battery_type, 7, 8), F)?,
                ),
                Metadata::reserved(sl(&battery_type, 0, 7), (7, 1)),
            ]),
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

fn get_manufacturer_info(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "GMIDB";

    let target = byte(data, 0, F)?;
    let fields = vec![
        Metadata::new(
            f(data, 0, 1),
            loc(0, 1),
            "Manufacturer Info Target",
            match target {
                0 => "Port/Cable Plug",
                1 => "Battery",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            f(data, 1, 2),
            loc(1, 2),
            "Manufacturer Info Ref",
            if target == 1 {
                battery_reference(byte(data, 1, F)?)
            } else {
                "Reserved".to_owned()
            },
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

fn manufacturer_info(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "MIDB";

    // VID and PID are 4 bytes before the string starts; anything shorter is truncated.
    let data_size = payload_size(ctx, F, 4)?;
    let text = bsl(data, 4, data_size);
    let fields = vec![
        Metadata::new(f(data, 0, 2), loc(0, 2), "VID", hex_le(data, 0, 2)),
        Metadata::new(f(data, 2, 4), loc(2, 4), "PID", hex_le(data, 2, 4)),
        Metadata::new(
            f(data, 4, data_size),
            loc(4, data_size),
            "Manufacturer String",
            ascii(text, F)?,
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// ---------------------------------------------------------------- PPS_Status

fn pps_status(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "PPSSDB";

    let voltage_raw = f(data, 0, 2);
    let current_raw = f(data, 2, 3);
    let rtf = f(data, 3, 4);

    let real_time_flags = vec![
        Metadata::reserved(sl(&rtf, 7, 8), (0, 0)),
        Metadata::new(
            sl(&rtf, 5, 7),
            (2, 1),
            "PTF",
            match sl(&rtf, 5, 7) {
                "00" => "Not Support",
                "01" => "Normal",
                "10" => "Warning",
                "11" => "Over Temperature",
                _ => "Reserved",
            },
        ),
        Metadata::new(sl(&rtf, 4, 5), (3, 3), "OMF", flag(sl(&rtf, 4, 5), F)?),
        Metadata::reserved(sl(&rtf, 0, 4), (7, 4)),
    ];

    let fields = vec![
        Metadata::new(
            voltage_raw.clone(),
            loc(0, 2),
            "Output Voltage",
            match num(&voltage_raw, F)? {
                0xFFFF => "Not Support".to_owned(),
                v => format!("{}V", py_float(v as f64 / 50.0)),
            },
        ),
        Metadata::new(
            current_raw.clone(),
            loc(2, 3),
            "Output Current",
            match num(&current_raw, F)? {
                0xFF => "Not Support".to_owned(),
                v => format!("{}A", py_float(v as f64 / 20.0)),
            },
        ),
        Metadata::new(
            rtf,
            loc(3, 4),
            "Real Time Flags",
            Value::List(real_time_flags),
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// ------------------------------------------------------------- Country blocks

fn country_info(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "CIDB";

    // Country code and reserved byte pair come before the country-specific data.
    let data_size = payload_size(ctx, F, 4)?;
    let fields = vec![
        Metadata::new(
            f(data, 0, 2),
            loc(0, 2),
            "Country Code",
            ascii(bsl(data, 0, 2), F)?,
        ),
        Metadata::reserved(f(data, 2, 4), loc(2, 4)),
        Metadata::new(
            f(data, 4, data_size),
            loc(4, data_size),
            "Country Specific Data",
            ascii(bsl(data, 4, data_size), F)?,
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

fn country_codes(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "CCDB";

    let data_size = ctx.data_size(F)?;
    let mut fields = vec![
        Metadata::new(f(data, 0, 1), loc(0, 1), "Length", byte(data, 0, F)? as u64),
        Metadata::reserved(f(data, 1, 2), loc(1, 2)),
    ];

    // The original wrote `range(1, data_size / 2)`, which raises `TypeError` on a
    // float, and dropped the codes it built.
    for i in 1..data_size / 2 {
        fields.push(Metadata::new(
            f(data, i * 2, (i + 1) * 2),
            loc(i * 2, (i + 1) * 2),
            format!("Country Code {i}"),
            ascii(bsl(data, i * 2, (i + 1) * 2), F)?,
        ));
    }

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// -------------------------------------------------- Sink_Capabilities_Extended

fn sink_capabilities_extended(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "SKEDB";

    let load_step = f(data, 11, 12);
    let slc = f(data, 12, 14);
    let compliance_raw = f(data, 14, 15);
    let bf = f(data, 16, 17);
    let sm = f(data, 17, 18);

    let compliance = vec![
        Metadata::new(
            sl(&compliance_raw, 7, 8),
            (0, 0),
            "Requires LPS Source",
            flag(sl(&compliance_raw, 7, 8), F)?,
        ),
        Metadata::new(
            sl(&compliance_raw, 6, 7),
            (1, 1),
            "Requires PS1 Source",
            flag(sl(&compliance_raw, 6, 7), F)?,
        ),
        Metadata::new(
            sl(&compliance_raw, 5, 6),
            (2, 2),
            "Requires PS2 Source",
            flag(sl(&compliance_raw, 5, 6), F)?,
        ),
        Metadata::reserved(sl(&compliance_raw, 0, 5), (7, 3)),
    ];

    let sink_modes = vec![
        Metadata::new(
            sl(&sm, 7, 8),
            (0, 0),
            "PPS Charging Supported",
            flag(sl(&sm, 7, 8), F)?,
        ),
        Metadata::new(
            sl(&sm, 6, 7),
            (1, 1),
            "VBUS Powered",
            flag(sl(&sm, 6, 7), F)?,
        ),
        Metadata::new(
            sl(&sm, 5, 6),
            (2, 2),
            "AC Supply Powered",
            flag(sl(&sm, 5, 6), F)?,
        ),
        Metadata::new(
            sl(&sm, 4, 5),
            (3, 3),
            "Battery Powered",
            flag(sl(&sm, 4, 5), F)?,
        ),
        Metadata::new(
            sl(&sm, 3, 4),
            (4, 4),
            "Battery Essentially Unlimited",
            flag(sl(&sm, 3, 4), F)?,
        ),
        Metadata::new(
            sl(&sm, 2, 3),
            (5, 5),
            "AVS Support",
            flag(sl(&sm, 2, 3), F)?,
        ),
        Metadata::reserved(sl(&sm, 0, 2), (7, 6)),
    ];

    /// SPR PDP ratings are 7-bit; the top bit is reserved.
    fn spr_pdp(raw: &str) -> Result<String> {
        Ok(format!("{}W", num(sl(raw, 1, 8), F)?))
    }

    let fields = vec![
        Metadata::new(f(data, 0, 2), loc(0, 2), "VID", hex_le(data, 0, 2)),
        Metadata::new(f(data, 2, 4), loc(2, 4), "PID", hex_le(data, 2, 4)),
        // The original printed bytes 0..2 here, repeating the VID.
        Metadata::new(f(data, 4, 8), loc(4, 8), "XID", hex_le(data, 4, 8)),
        Metadata::new(f(data, 8, 9), loc(8, 9), "FW Version", hex_le(data, 8, 9)),
        Metadata::new(
            f(data, 9, 10),
            loc(9, 10),
            "HW Version",
            hex_le(data, 9, 10),
        ),
        Metadata::new(
            f(data, 10, 11),
            loc(10, 11),
            "SKEDB Version",
            if byte(data, 10, F)? == 1 {
                "Version 1.0"
            } else {
                "Reserved"
            },
        ),
        Metadata::new(
            load_step.clone(),
            loc(11, 12),
            "Load Step",
            match sl(&load_step, 6, 8) {
                "00" => "150mA/\u{3bc}s",
                "01" => "500mA/\u{3bc}s",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            slc.clone(),
            loc(12, 14),
            "Sink Load Characteristics",
            Value::List(overload_profile(&slc, F, "Percent Overload")?),
        ),
        Metadata::new(
            compliance_raw,
            loc(14, 15),
            "Compliance",
            Value::List(compliance),
        ),
        Metadata::new(
            f(data, 15, 16),
            loc(15, 16),
            "Touch Temp",
            match byte(data, 15, F)? {
                0 => "Not Applicable",
                1 => "[IEC 60950-1]",
                2 => "[IEC 62368-1] TS1",
                3 => "[IEC 62368-1] TS2",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            bf.clone(),
            loc(16, 17),
            "Battery Info",
            Value::List(vec![
                Metadata::new(
                    sl(&bf, 0, 4),
                    (7, 4),
                    "Hot Swappable Battery",
                    sl(&bf, 0, 4),
                ),
                Metadata::new(sl(&bf, 4, 8), (3, 0), "Fixed Batteries", sl(&bf, 4, 8)),
            ]),
        ),
        Metadata::new(sm, loc(17, 18), "Sink Modes", Value::List(sink_modes)),
        Metadata::new(
            f(data, 18, 19),
            loc(18, 19),
            "SPR Sink Minimum PDP",
            spr_pdp(&f(data, 18, 19))?,
        ),
        Metadata::new(
            f(data, 19, 20),
            loc(19, 20),
            "SPR Sink Operational PDP",
            spr_pdp(&f(data, 19, 20))?,
        ),
        Metadata::new(
            f(data, 20, 21),
            loc(20, 21),
            "SPR Sink Maximum PDP",
            spr_pdp(&f(data, 20, 21))?,
        ),
        Metadata::new(
            f(data, 21, 22),
            loc(21, 22),
            "EPR Sink Minimum PDP",
            format!("{}W", num(&f(data, 21, 22), F)?),
        ),
        Metadata::new(
            f(data, 22, 23),
            loc(22, 23),
            "EPR Sink Operational PDP",
            format!("{}W", num(&f(data, 22, 23), F)?),
        ),
        Metadata::new(
            f(data, 23, 24),
            loc(23, 24),
            "EPR Sink Maximum PDP",
            format!("{}W", num(&f(data, 23, 24), F)?),
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// ----------------------------------------------------------- Extended_Control

fn extended_control(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "ECDB";

    let fields = vec![
        Metadata::new(
            f(data, 0, 1),
            loc(0, 1),
            "Type",
            match byte(data, 0, F)? {
                1 => "EPR_Get_Source_Cap",
                2 => "EPR_Get_Sink_Cap",
                3 => "EPR_KeepAlive",
                4 => "EPR_KeepAlive_Ack",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            f(data, 1, 2),
            loc(1, 2),
            "Data",
            format!("0x{}", hex_upper(bsl(data, 1, 2))),
        ),
    ];

    Ok(Metadata::new(
        bits(data, Order::Big),
        bit_loc,
        F,
        Value::List(fields),
    ))
}

// --------------------------------------------------------- Chunk reassembly

/// What a chunk of a chunked extended message contributes.
enum Chunk {
    /// The peer is asking for the next chunk; nothing to reassemble.
    Requested,
    /// Bytes of every chunk so far, and whether they now cover `Data Size`.
    Assembled {
        full_data: Vec<u8>,
        complete: bool,
        /// Data objects accumulated so far, for the EPR capability messages.
        num_objs: Option<f64>,
        /// The chunk number a continuation of this reassembly must carry.
        next_chunk: u64,
    },
}

/// Append this chunk to the message in flight, if there is one.
fn assemble(field: &'static str, data: &[u8], ctx: &Ctx<'_>, track_objs: bool) -> Result<Chunk> {
    let ex_header = ctx.ex_header(field)?;

    if ex_header
        .get(crate::fields::REQUEST_CHUNK)
        .and_then(|m| m.value().as_bool())
        == Some(true)
    {
        return Ok(Chunk::Requested);
    }

    let data_size = ctx.data_size(field)?;
    let chunk_no = ex_header
        .get(crate::fields::CHUNK_NUMBER)
        .and_then(|m| m.value().as_int())
        .filter(|n| *n >= 0)
        .map(|n| n as u64)
        .ok_or(ParseError::Truncated { field })?;

    // Half an object of every chunk is spent on the extended header, so the running
    // object count advances by `num_objs - 0.5` per chunk.
    let this_chunk_objs = ctx.num_objs() as f64 - 0.5;

    let (full_data, num_objs) = if needs_previous_chunk(ex_header) {
        let last_ext = ctx.last_ext(field)?;
        let previous = last_ext.get(field).ok_or(ParseError::MissingContext {
            which: "last_ext",
            field,
        })?;
        let bytes = previous.chunk_data().ok_or(ParseError::MissingContext {
            which: "last_ext",
            field,
        })?;

        // Chunks arrive in order or not at all. A chunk that does not continue the
        // reassembly in flight has a predecessor we never saw, and concatenating it
        // anyway would present two unrelated fragments as one message.
        if previous.chunk_next() != Some(chunk_no) {
            return Err(ParseError::MissingContext {
                which: "last_ext",
                field,
            });
        }

        let mut full = Vec::with_capacity(bytes.len() + data.len());
        full.extend_from_slice(bytes);
        full.extend_from_slice(data);
        let objs = previous.chunk_num_objs().unwrap_or(0.0) + this_chunk_objs;

        // The message says how long it is, so that is as far as reassembly can
        // usefully go. Without this a peer that keeps sending chunk 1 grows the
        // buffer forever, and pays a full copy of it on every message. Capping at
        // `data_size` never cuts into this chunk's own bytes, and only the
        // accumulating path is capped so a single chunk still reports verbatim.
        full.truncate(data_size.max(data.len()));
        (full, objs)
    } else {
        (data.to_vec(), this_chunk_objs)
    };

    let complete = full_data.len() >= data_size;

    Ok(Chunk::Assembled {
        full_data,
        complete,
        num_objs: track_objs.then_some(num_objs),
        next_chunk: chunk_no + 1,
    })
}

/// Build a chunked body once its value is known.
fn chunked(
    field: &'static str,
    data: &[u8],
    bit_loc: (u32, u32),
    chunk: Chunk,
    value: impl FnOnce(&[u8]) -> Result<Value>,
) -> Result<Metadata> {
    let raw = bits(data, Order::Big);
    // Unlike the original, which reported a constant "Incomplete Data" here, this
    // is the value carried by *this* chunk alone.
    let this_chunk = Value::Str(format!("0x{}", hex_upper(data)));

    match chunk {
        Chunk::Requested => Ok(Metadata::new(raw.clone(), bit_loc, field, Value::None)
            .with_chunks(Raw::Bits(raw), Value::None, None, None, None)),
        Chunk::Assembled {
            full_data,
            complete,
            num_objs,
            next_chunk,
        } => {
            let assembled = if complete {
                value(&full_data)?
            } else {
                Value::Str("Incomplete Data".to_owned())
            };
            let full_raw = Raw::Bits(bits(&full_data, Order::Big));
            Ok(Metadata::new(raw, bit_loc, field, assembled).with_chunks(
                full_raw,
                this_chunk,
                Some(full_data),
                num_objs,
                Some(next_chunk),
            ))
        }
    }
}

/// Security and firmware-update payloads, which the spec leaves opaque.
fn blob(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>, field: &'static str) -> Result<Metadata> {
    let data_size = ctx.data_size(field)?;
    let chunk = assemble(field, data, ctx, false)?;
    chunked(field, data, bit_loc, chunk, |full| {
        Ok(Value::Str(format!(
            "0x{}",
            hex_upper(bsl(full, 0, data_size))
        )))
    })
}

fn epr_capabilities(
    data: &[u8],
    bit_loc: (u32, u32),
    ctx: &Ctx<'_>,
    sink: bool,
) -> Result<Metadata> {
    const F: &str = "Data Block";

    let prop = ctx.prop_protocol;
    let chunk = assemble(F, data, ctx, true)?;
    let total_objs = match &chunk {
        Chunk::Assembled { num_objs, .. } => num_objs.unwrap_or(0.0).max(0.0) as usize,
        Chunk::Requested => 0,
    };

    chunked(F, data, bit_loc, chunk, |full| {
        // Every object position counted must actually be present. Checking once here
        // beats relying on each iteration: an absent object slices to an empty bit
        // string, and `"".bytes().all(..)` is vacuously true, so it would otherwise
        // be reported as a padding `Empty PDO` rather than as a truncated message.
        if total_objs * 4 > full.len() {
            return Err(ParseError::Truncated { field: F });
        }

        let pdos = (0..total_objs)
            .map(|i| {
                let raw = bits(bsl(full, i * 4, (i + 1) * 4), Order::Little);
                let loc = (i as u32 * 32, (i as u32 + 1) * 32 - 1);
                let name = format!("PDO {}", i + 1);
                // An EPR capabilities message pads unused positions with zeroes.
                if !raw.is_empty() && raw.bytes().all(|b| b == b'0') {
                    Ok(Metadata::new(raw, loc, name, "Empty PDO"))
                } else if sink {
                    parse_sink_pdo(&raw, loc, name, prop)
                } else {
                    parse_pdo(&raw, loc, name, prop)
                }
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Value::List(pdos))
    })
}

fn vendor_defined_extended(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "Data Block";

    // The VDM Header occupies the first 4 bytes; a shorter block cannot be decoded.
    let data_size = payload_size(ctx, F, 4)?;
    let chunk = assemble(F, data, ctx, false)?;
    chunked(F, data, bit_loc, chunk, |full| {
        Ok(Value::List(vec![
            vdo::vdm_header(&bits(bsl(full, 0, 4), Order::Little), (0, 31))?,
            Metadata::new(
                bits(bsl(full, 4, data_size), Order::Little),
                loc(4, data_size),
                "VDEDB",
                format!("0x{}", hex_upper(bsl(full, 4, data_size))),
            ),
        ]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::{ex_msg_header, msg_header, Sop};

    /// A Message Header claiming `num_objs` data objects, and an Extended Message
    /// Header with the given chunk state.
    fn headers(num_objs: u16, chunked: bool, chunk_no: u16, size: u16) -> (Metadata, Metadata) {
        let raw = format!("1{num_objs:03b}000000000010");
        let header = msg_header(&raw, (0, 15), Sop::Sop).unwrap();
        let ex_raw = format!("{}{chunk_no:04b}00{size:09b}", u8::from(chunked));
        let ex_header = ex_msg_header(&ex_raw, (16, 31)).unwrap();
        (header, ex_header)
    }

    /// The context a body sees. `header`/`ex_header`/`last_ext` must outlive it.
    fn ctx<'a>(
        header: &'a Metadata,
        ex_header: &'a Metadata,
        last_ext: Option<&'a Metadata>,
    ) -> Ctx<'a> {
        Ctx {
            sop: Sop::Sop,
            header,
            ex_header: Some(ex_header),
            last_pdo: None,
            last_ext,
            last_rdo: None,
            prop_protocol: false,
        }
    }

    #[test]
    fn an_unchunked_blob_is_complete_immediately() {
        let (h, ex) = headers(2, false, 0, 4);
        let body = blob(
            &[0xDE, 0xAD, 0xBE, 0xEF],
            (32, 63),
            &ctx(&h, &ex, None),
            "SRQDB",
        )
        .unwrap();
        assert_eq!(body.value().as_str(), Some("0xDEADBEEF"));
        assert_eq!(body.raw_value().as_str(), Some("0xDEADBEEF"));
    }

    #[test]
    fn a_chunk_request_carries_no_value() {
        let (h, _) = headers(1, true, 1, 64);
        // Chunked, chunk 1, Request Chunk set, size 8.
        let ex = ex_msg_header("1000110000001000", (16, 31)).unwrap();
        assert_eq!(
            ex.get("Request Chunk").unwrap().value().as_bool(),
            Some(true)
        );

        let body = blob(&[], (32, 32), &ctx(&h, &ex, None), "SRQDB").unwrap();
        assert_eq!(body.value(), &Value::None);
    }

    #[test]
    fn chunks_accumulate_until_data_size_is_covered() {
        // Chunk 0 of an 8-byte payload delivers 4 bytes: still incomplete.
        let (h, ex) = headers(3, true, 0, 8);
        let first = blob(
            &[0x01, 0x02, 0x03, 0x04],
            (32, 63),
            &ctx(&h, &ex, None),
            "SRQDB",
        )
        .unwrap();
        assert_eq!(first.value().as_str(), Some("Incomplete Data"));

        // Chunk 1 completes it, against the previous message as context.
        let previous = Metadata::new("", (0, 0), "PD", Value::List(vec![first]));
        let (h2, ex2) = headers(3, true, 1, 8);
        let second = blob(
            &[0x05, 0x06, 0x07, 0x08],
            (32, 63),
            &ctx(&h2, &ex2, Some(&previous)),
            "SRQDB",
        )
        .unwrap();

        assert_eq!(second.value().as_str(), Some("0x0102030405060708"));
        // raw_value stays scoped to this chunk; full_raw spans both.
        assert_eq!(second.raw_value().as_str(), Some("0x05060708"));
        assert_eq!(second.full_raw().as_str().len(), 64);
    }

    #[test]
    fn a_later_chunk_without_context_is_an_error() {
        let (h, ex) = headers(3, true, 1, 8);
        assert!(matches!(
            blob(&[0x05, 0x06], (32, 47), &ctx(&h, &ex, None), "SRQDB"),
            Err(ParseError::MissingContext {
                which: "last_ext",
                ..
            })
        ));
    }

    #[test]
    fn country_codes_lists_every_code() {
        // The original raised TypeError here and never reached the codes.
        let (h, ex) = headers(3, false, 0, 6);
        let body = country_codes(b"\x04\x00USCN", (32, 79), &ctx(&h, &ex, None)).unwrap();
        assert_eq!(body.get("Length").unwrap().value().as_int(), Some(4));
        assert_eq!(
            body.get("Country Code 1").unwrap().value().as_str(),
            Some("US")
        );
        assert_eq!(
            body.get("Country Code 2").unwrap().value().as_str(),
            Some("CN")
        );
    }

    #[test]
    fn scedb_xid_reads_its_own_bytes() {
        // VID 0x1234, PID 0x5678, XID 0xAABBCCDD. The original echoed the VID here.
        let mut data = vec![0x34, 0x12, 0x78, 0x56, 0xDD, 0xCC, 0xBB, 0xAA];
        data.resize(25, 0);
        let body = source_capabilities_extended(&data, (32, 231)).unwrap();
        assert_eq!(body.get("VID").unwrap().value().as_str(), Some("0x1234"));
        assert_eq!(
            body.get("XID").unwrap().value().as_str(),
            Some("0xAABBCCDD")
        );
    }

    #[test]
    fn pps_status_reports_unsupported_readings() {
        let body = pps_status(&[0xFF, 0xFF, 0xFF, 0x00], (32, 63)).unwrap();
        assert_eq!(
            body.get("Output Voltage").unwrap().value().as_str(),
            Some("Not Support")
        );
        assert_eq!(
            body.get("Output Current").unwrap().value().as_str(),
            Some("Not Support")
        );

        let body = pps_status(&[0xE8, 0x03, 0x3C, 0x00], (32, 63)).unwrap();
        assert_eq!(
            body.get("Output Voltage").unwrap().value().as_str(),
            Some("20.0V")
        );
        assert_eq!(
            body.get("Output Current").unwrap().value().as_str(),
            Some("3.0A")
        );
    }

    #[test]
    fn battery_references_split_fixed_from_hot_swappable() {
        assert_eq!(battery_reference(0), "Fixed Battery 0");
        assert_eq!(battery_reference(3), "Fixed Battery 3");
        assert_eq!(battery_reference(4), "Hot Swappable Battery 0");
        assert_eq!(battery_reference(7), "Hot Swappable Battery 3");
        assert_eq!(battery_reference(8), "Reserved");
    }

    /// `Data Size` is a 9-bit field, so zero is encodable. It used to reach
    /// `loc(4, 0)`, whose `0 * 8 - 1` underflowed: a panic under debug assertions,
    /// and a `[b32-b4294967295]` bit range without them.
    #[test]
    fn a_body_shorter_than_its_own_header_is_truncated() {
        for (name, size) in [("empty", 0u16), ("one byte", 1), ("three bytes", 3)] {
            let (h, ex) = headers(1, false, 0, size);
            let ctx = ctx(&h, &ex, None);
            for (label, body) in [
                (
                    "MIDB",
                    manufacturer_info(b"\x34\x12\x78\x56", (32, 63), &ctx),
                ),
                ("CIDB", country_info(b"US\x00\x00", (32, 63), &ctx)),
                (
                    "VDEDB",
                    vendor_defined_extended(b"\x01\x80\x00\xFF", (32, 63), &ctx),
                ),
            ] {
                assert!(
                    matches!(body, Err(ParseError::Truncated { .. })),
                    "{label} with a {name} Data Size should be truncated"
                );
            }
        }
    }

    /// A `Data Size` that covers the fixed header still decodes.
    #[test]
    fn a_body_exactly_as_long_as_its_header_still_decodes() {
        let (h, ex) = headers(1, false, 0, 4);
        let ctx = ctx(&h, &ex, None);
        let body = manufacturer_info(b"\x34\x12\x78\x56", (32, 63), &ctx).unwrap();
        assert_eq!(body.get("VID").unwrap().value().as_str(), Some("0x1234"));
        // An empty manufacturer string is legal, and its bit range no longer wraps.
        assert_eq!(
            body.get("Manufacturer String").unwrap().bit_loc(),
            crate::metadata::BitLoc::Bits(32, 32)
        );
    }

    /// Even an in-order run of chunks cannot grow past what the message claims. The
    /// buffer used to be unbounded, and re-copied in full on every message.
    #[test]
    fn chunk_accumulation_is_bounded_by_data_size() {
        const SIZE: u16 = 8;

        let (h0, ex0) = headers(3, true, 0, SIZE);
        let mut previous = Metadata::new(
            "",
            (0, 0),
            "PD",
            Value::List(vec![blob(
                &[0x01, 0x02, 0x03, 0x04],
                (32, 63),
                &ctx(&h0, &ex0, None),
                "SRQDB",
            )
            .unwrap()]),
        );

        // Chunk Number is four bits wide, so this is every continuation there can be.
        for chunk_no in 1..16u16 {
            let (h, ex) = headers(3, true, chunk_no, SIZE);
            let body = blob(
                &[0xAA, 0xBB, 0xCC, 0xDD],
                (32, 63),
                &ctx(&h, &ex, Some(&previous)),
                "SRQDB",
            )
            .unwrap();
            let bytes = body.full_raw().as_str().len() / 8;
            assert!(
                bytes <= SIZE as usize,
                "chunk {chunk_no}: accumulated {bytes} bytes for a {SIZE}-byte message"
            );
            previous = Metadata::new("", (0, 0), "PD", Value::List(vec![body]));
        }
    }

    /// A chunk that does not continue the reassembly in flight has a predecessor we
    /// never saw. Concatenating it anyway presented two unrelated fragments as one
    /// message — and let a peer repeat chunk 1 forever.
    #[test]
    fn a_chunk_that_does_not_continue_the_one_in_flight_is_rejected() {
        let (h0, ex0) = headers(3, true, 0, 64);
        let first = blob(
            &[0x01, 0x02, 0x03, 0x04],
            (32, 63),
            &ctx(&h0, &ex0, None),
            "SRQDB",
        )
        .unwrap();
        let previous = Metadata::new("", (0, 0), "PD", Value::List(vec![first]));

        // Chunk 0 was just seen, so chunk 1 continues it and anything else does not.
        for chunk_no in [2u16, 3, 15] {
            let (h, ex) = headers(3, true, chunk_no, 64);
            assert!(
                matches!(
                    blob(
                        &[0x05, 0x06],
                        (32, 47),
                        &ctx(&h, &ex, Some(&previous)),
                        "SRQDB"
                    ),
                    Err(ParseError::MissingContext {
                        which: "last_ext",
                        ..
                    })
                ),
                "chunk {chunk_no} should not continue chunk 0"
            );
        }

        let (h, ex) = headers(3, true, 1, 64);
        assert!(blob(
            &[0x05, 0x06],
            (32, 47),
            &ctx(&h, &ex, Some(&previous)),
            "SRQDB"
        )
        .is_ok());

        // Repeating a chunk is the same thing: chunk 1 does not follow chunk 1.
        let second = blob(
            &[0x05, 0x06],
            (32, 47),
            &ctx(&h, &ex, Some(&previous)),
            "SRQDB",
        )
        .unwrap();
        let after_one = Metadata::new("", (0, 0), "PD", Value::List(vec![second]));
        assert!(matches!(
            blob(
                &[0x07, 0x08],
                (32, 47),
                &ctx(&h, &ex, Some(&after_one)),
                "SRQDB"
            ),
            Err(ParseError::MissingContext {
                which: "last_ext",
                ..
            })
        ));
    }

    /// An object position past the end of the block sliced to an empty bit string,
    /// and `"".bytes().all(..)` is vacuously true — so it read as padding.
    #[test]
    fn an_epr_object_past_the_end_of_the_block_is_truncated_not_empty() {
        // Seven objects claimed — so six after the extended header — but the block
        // carries one PDO and nothing more. `Data Size` is covered, so reassembly
        // reports complete and the objects really are decoded.
        let (h, ex) = headers(7, false, 0, 4);
        let body = epr_capabilities(
            &[0x2C, 0x91, 0x01, 0x08],
            (32, 63),
            &ctx(&h, &ex, None),
            false,
        );
        assert!(
            matches!(
                body,
                Err(ParseError::Truncated {
                    field: "Data Block"
                })
            ),
            "{body:?}"
        );
    }
}
