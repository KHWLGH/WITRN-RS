//! Data Message bodies — the `Data Objects` block of a non-extended PD message.

use crate::bits::{bits, bsl, flag, hex_rev_upper, num, sl, Order};
use crate::context::Ctx;
use crate::error::{ParseError, Result};
use crate::header::Sop;
use crate::metadata::{Metadata, Value};
use crate::pdo::{parse_pdo, parse_sink_pdo};
use crate::rdo::parse_rdo;
use crate::vdo;

/// Decode the body of a Data Message, or return `None` if the message type carries
/// no body (every Control Message, and any type the spec has not assigned).
pub(crate) fn parse(
    message_type: &str,
    data: &[u8],
    bit_loc: (u32, u32),
    ctx: &Ctx<'_>,
) -> Option<Result<Metadata>> {
    let parsed = match message_type {
        "Source_Capabilities" => source_capabilities(data, bit_loc, ctx),
        "Request" => request(data, bit_loc, ctx),
        "BIST" => bist(data, bit_loc, ctx),
        "Sink_Capabilities" => sink_capabilities(data, bit_loc, ctx),
        "Battery_Status" => battery_status(data, bit_loc),
        "Alert" => alert(data, bit_loc, ctx),
        "Get_Country_Info" => get_country_info(data, bit_loc),
        "Enter_USB" => enter_usb(data, bit_loc),
        "EPR_Request" => epr_request(data, bit_loc, ctx),
        "EPR_Mode" => epr_mode(data, bit_loc),
        "Source_Info" => source_info(data, bit_loc),
        "Revision" => revision(data, bit_loc),
        "Vendor_Defined" => vendor_defined(data, bit_loc, ctx),
        "Reserved" => Ok(crate::ext_msg::reserved_block(data, bit_loc)),
        _ => return None,
    };
    Some(parsed)
}

const OBJECTS: &str = "Data Objects";

/// Bits of the whole block, in wire order.
fn block_raw(data: &[u8]) -> String {
    bits(data, Order::Big)
}

/// Bits of the `i`th 32-bit data object, MSB-first.
fn object(data: &[u8], i: usize) -> String {
    bits(bsl(data, i * 4, (i + 1) * 4), Order::Little)
}

fn object_loc(i: usize) -> (u32, u32) {
    (i as u32 * 32, (i as u32 + 1) * 32 - 1)
}

// -------------------------------------------------------- Source/Sink capabilities

fn source_capabilities(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    let pdos = (0..ctx.num_objs())
        .map(|i| {
            parse_pdo(
                &object(data, i),
                object_loc(i),
                format!("PDO {}", i + 1),
                ctx.prop_protocol,
            )
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(pdos),
    ))
}

fn sink_capabilities(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    let pdos = (0..ctx.num_objs())
        .map(|i| {
            parse_sink_pdo(
                &object(data, i),
                object_loc(i),
                format!("PDO {}", i + 1),
                ctx.prop_protocol,
            )
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(pdos),
    ))
}

// -------------------------------------------------------------------- Request

/// The PDO list of a stored Source_Capabilities.
///
/// An SPR capabilities message names the block `Data Objects`; the EPR one names it
/// `Data Block`. The original only looked for the former, so a Request that followed
/// EPR_Source_Capabilities failed to decode.
pub(crate) fn context_pdos<'a>(
    last_pdo: &'a Metadata,
    field: &'static str,
) -> Result<&'a [Metadata]> {
    last_pdo.data_objects().ok_or(ParseError::MissingContext {
        which: "last_pdo",
        field,
    })
}

/// Resolve an RDO's 1-based Object Position against the stored capabilities.
pub(crate) fn pdo_at(pdos: &[Metadata], rdo_raw: &str, field: &'static str) -> Result<Metadata> {
    let position = num(sl(rdo_raw, 0, 4), field)?;
    let index = position
        .checked_sub(1)
        .and_then(|i| usize::try_from(i).ok())
        .filter(|i| *i < pdos.len())
        .ok_or(ParseError::BadObjectPosition {
            position,
            available: pdos.len(),
        })?;
    Ok(pdos[index].clone())
}

fn request(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    let raw = block_raw(data);

    // A Request with no capabilities on record is reported rather than rejected,
    // matching the original.
    let Some(last_pdo) = ctx.last_pdo else {
        return Ok(Metadata::new(
            raw,
            bit_loc,
            OBJECTS,
            "Invalid Request Message",
        ));
    };

    let pdos = context_pdos(last_pdo, "Request")?;
    let rdo_raw = object(data, 0);
    let pdo = pdo_at(pdos, &rdo_raw, "Request")?;
    let rdo = parse_rdo(&rdo_raw, (0, 31), "RDO", pdo, ctx.prop_protocol)?;

    Ok(Metadata::new(raw, bit_loc, OBJECTS, Value::List(vec![rdo])))
}

fn epr_request(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    // An EPR_Request carries the PDO it is requesting against, so it needs no context.
    let copy_raw = object(data, 1);
    let copy = parse_pdo(&copy_raw, (32, 63), "Copy of PDO", ctx.prop_protocol)?;
    let rdo = parse_rdo(
        &object(data, 0),
        (0, 31),
        "RDO",
        copy.clone(),
        ctx.prop_protocol,
    )?;

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![rdo, copy]),
    ))
}

// ----------------------------------------------------------------------- BIST

fn bist(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "BIST";

    let raw = object(data, 0);
    let mode = match sl(&raw, 0, 4) {
        "0101" => "BIST Carrier Mode",
        "1000" => "BIST Test Data",
        "1001" => "BIST Shared Test Mode Entry",
        "1010" => "BIST Shared Test Mode Exit",
        _ => "Reserved",
    };

    let bdo = vec![
        Metadata::new(sl(&raw, 0, 4), (31, 28), "BIST Mode", mode),
        Metadata::reserved(sl(&raw, 4, 32), (27, 0)),
    ];

    let mut fields = vec![Metadata::new(
        raw.clone(),
        (0, 31),
        "BIST Data Object",
        Value::List(bdo),
    )];

    let num_objs = ctx.num_objs();
    if num_objs > 1 {
        let test = bsl(data, 4, num_objs * 4);
        // A truncated BIST message has no test data to report.
        if test.is_empty() {
            return Err(ParseError::Truncated { field: F });
        }
        fields.push(Metadata::new(
            bits(test, Order::Little),
            (32, num_objs as u32 * 32 - 1),
            "Test Data",
            format!("0x{}", hex_rev_upper(test)),
        ));
    }

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(fields),
    ))
}

// ------------------------------------------------------------- Battery_Status

fn battery_status(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "BSDO";

    let raw = object(data, 0);
    let present = flag(sl(&raw, 22, 23), F)?;

    let info = vec![
        Metadata::new(
            sl(&raw, 23, 24),
            (0, 0),
            "Invalid Battery Reference",
            flag(sl(&raw, 23, 24), F)?,
        ),
        Metadata::new(sl(&raw, 22, 23), (1, 1), "Battery Present", present),
        Metadata::new(
            sl(&raw, 20, 22),
            (3, 2),
            "Battery Charging Status",
            if present {
                match sl(&raw, 20, 22) {
                    "00" => "Battery is Charging",
                    "01" => "Battery is Discharging",
                    "10" => "Battery is Idle",
                    _ => "Reserved",
                }
            } else {
                "Reserved"
            },
        ),
        Metadata::reserved(sl(&raw, 16, 20), (7, 4)),
    ];

    let bsdo = vec![
        Metadata::new(
            sl(&raw, 0, 16),
            (31, 16),
            "Battery Present Capacity",
            format!(
                "{}Wh",
                crate::bits::py_float(num(sl(&raw, 0, 16), F)? as f64 / 10.0)
            ),
        ),
        Metadata::new(sl(&raw, 16, 24), (15, 8), "Battery Info", Value::List(info)),
        Metadata::reserved(sl(&raw, 24, 32), (7, 0)),
    ];

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(raw, (0, 31), "BSDO", Value::List(bsdo))]),
    ))
}

// ---------------------------------------------------------------------- Alert

fn alert(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "ADO";

    let raw = object(data, 0);
    let extended_alert = flag(sl(&raw, 0, 1), F)?;

    let mut alerts = vec![
        Metadata::reserved(sl(&raw, 7, 8), (0, 0)),
        Metadata::new(
            sl(&raw, 6, 7),
            (1, 1),
            "Battery Status Changed Event",
            flag(sl(&raw, 6, 7), F)?,
        ),
        Metadata::new(
            sl(&raw, 5, 6),
            (2, 2),
            "OCP Event",
            flag(sl(&raw, 5, 6), F)?,
        ),
    ];

    // Over-temperature is a Source-only condition.
    alerts.push(match ctx.power_role() {
        "Source" => Metadata::new(
            sl(&raw, 4, 5),
            (3, 3),
            "OTP Event",
            flag(sl(&raw, 4, 5), F)?,
        ),
        _ => Metadata::reserved(sl(&raw, 4, 5), (3, 3)),
    });

    alerts.extend([
        Metadata::new(
            sl(&raw, 3, 4),
            (4, 4),
            "Operating Condition Change",
            flag(sl(&raw, 3, 4), F)?,
        ),
        Metadata::new(
            sl(&raw, 2, 3),
            (5, 5),
            "Source Input Change Event",
            flag(sl(&raw, 2, 3), F)?,
        ),
        Metadata::new(
            sl(&raw, 1, 2),
            (6, 6),
            "OVP Event",
            flag(sl(&raw, 1, 2), F)?,
        ),
        Metadata::new(
            sl(&raw, 0, 1),
            (7, 7),
            "Extended Alert Event",
            extended_alert,
        ),
    ]);

    let ado = vec![
        Metadata::new(
            sl(&raw, 0, 8),
            (31, 24),
            "Type of Alert",
            Value::List(alerts),
        ),
        Metadata::new(
            sl(&raw, 8, 12),
            (23, 20),
            "Fixed Batteries",
            sl(&raw, 8, 12),
        ),
        Metadata::new(
            sl(&raw, 12, 16),
            (19, 16),
            "Hot Swappable Batteries",
            sl(&raw, 12, 16),
        ),
        Metadata::reserved(sl(&raw, 16, 28), (15, 4)),
        Metadata::new(
            sl(&raw, 28, 32),
            (3, 0),
            "Extended Alert Event Type",
            if extended_alert {
                match sl(&raw, 28, 32) {
                    "0001" => "Power State Change",
                    "0010" => "Power Button Press",
                    "0011" => "Power Button Release",
                    "0100" => "Controller Initiated Wake",
                    _ => "Reserved",
                }
            } else {
                "Reserved"
            },
        ),
    ];

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(raw, (0, 31), "ADO", Value::List(ado))]),
    ))
}

// ----------------------------------------------------------- Get_Country_Info

fn get_country_info(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "CCDO";

    let raw = object(data, 0);
    let ccdo = vec![
        Metadata::new(
            sl(&raw, 0, 8),
            (31, 24),
            "First character of the Alpha-2 Country Code",
            format!("0x{:02X}", num(sl(&raw, 0, 8), F)?),
        ),
        Metadata::new(
            sl(&raw, 8, 16),
            (23, 16),
            "Second character of the Alpha-2 Country Code",
            format!("0x{:02X}", num(sl(&raw, 8, 16), F)?),
        ),
        Metadata::reserved(sl(&raw, 16, 32), (15, 0)),
    ];

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(raw, (0, 31), "CCDO", Value::List(ccdo))]),
    ))
}

// ------------------------------------------------------------------ Enter_USB

fn enter_usb(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "EUDO";

    let raw = object(data, 0);
    let eudo = vec![
        Metadata::reserved(sl(&raw, 0, 1), (31, 31)),
        Metadata::new(
            sl(&raw, 1, 4),
            (30, 28),
            "USB Mode",
            match sl(&raw, 1, 4) {
                "000" => "[USB 2.0]",
                "001" => "[USB 3.2]",
                "010" => "[USB4]",
                _ => "Reserved",
            },
        ),
        Metadata::reserved(sl(&raw, 4, 5), (27, 27)),
        Metadata::new(
            sl(&raw, 5, 6),
            (26, 26),
            "USB4 DRD",
            if flag(sl(&raw, 5, 6), F)? {
                "Capable"
            } else {
                "Not Capable"
            },
        ),
        Metadata::new(
            sl(&raw, 6, 7),
            (25, 25),
            "USB3 DRD",
            if flag(sl(&raw, 6, 7), F)? {
                "Capable"
            } else {
                "Not Capable"
            },
        ),
        Metadata::reserved(sl(&raw, 7, 8), (24, 24)),
        Metadata::new(
            sl(&raw, 8, 11),
            (23, 21),
            "Cable Speed",
            match sl(&raw, 8, 11) {
                "000" => "[USB 2.0] Only",
                "001" => "[USB 3.2] Gen1",
                "010" => "[USB 3.2] Gen2 and [USB4] Gen2",
                "011" => "[USB4] Gen3",
                "100" => "[USB4] Gen4",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            sl(&raw, 11, 13),
            (20, 19),
            "Cable Type",
            match sl(&raw, 11, 13) {
                "00" => "Passive",
                "01" => "Active Re-timer",
                "10" => "Active Re-driver",
                "11" => "Optical Isolated",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            sl(&raw, 13, 15),
            (18, 17),
            "Cable Current",
            match sl(&raw, 13, 15) {
                "00" => "VBUS is not supported",
                "10" => "3A",
                "11" => "5A",
                _ => "Reserved",
            },
        ),
        Metadata::new(
            sl(&raw, 15, 16),
            (16, 16),
            "PCIe Support",
            flag(sl(&raw, 15, 16), F)?,
        ),
        Metadata::new(
            sl(&raw, 16, 17),
            (15, 15),
            "DP Support",
            flag(sl(&raw, 16, 17), F)?,
        ),
        Metadata::new(
            sl(&raw, 17, 18),
            (14, 14),
            "TBT Support",
            flag(sl(&raw, 17, 18), F)?,
        ),
        Metadata::new(
            sl(&raw, 18, 19),
            (13, 13),
            "Host Present",
            flag(sl(&raw, 18, 19), F)?,
        ),
        Metadata::reserved(sl(&raw, 19, 32), (12, 0)),
    ];

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(raw, (0, 31), "EUDO", Value::List(eudo))]),
    ))
}

// ------------------------------------------------------------------- EPR_Mode

fn epr_mode(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "EPRMDO";

    let action_byte = *bsl(data, 3, 4)
        .first()
        .ok_or(ParseError::Truncated { field: F })?;
    let data_byte = *bsl(data, 2, 3)
        .first()
        .ok_or(ParseError::Truncated { field: F })?;

    let action = match action_byte {
        1 => "Enter",
        2 => "Enter Acknowledged",
        3 => "Enter Succeeded",
        4 => "Enter Failed",
        5 => "Exit",
        _ => "Reserved",
    };

    let mut eprmdo = vec![Metadata::new(
        bits(bsl(data, 3, 4), Order::Little),
        (31, 24),
        "Action",
        action,
    )];

    let data_value: Option<Value> = match action {
        "Enter" => Some(format!("{data_byte}W").into()),
        "Enter Acknowledged" | "Enter Succeeded" | "Exit" => Some("Reserved".into()),
        "Enter Failed" => Some(
            match data_byte {
                0 => "Unknown cause",
                1 => "Cable not EPR Capable",
                2 => "Source failed to become VCONN Source",
                3 => "EPR Capable bit not set in RDO",
                4 => "Source unable to enter EPR Mode",
                5 => "EPR Capable bit not set in PDO",
                _ => "Reserved",
            }
            .into(),
        ),
        _ => None,
    };

    if let Some(value) = data_value {
        eprmdo.push(Metadata::new(
            bits(bsl(data, 2, 3), Order::Little),
            (23, 16),
            "Data",
            value,
        ));
    }

    eprmdo.push(Metadata::reserved(
        bits(bsl(data, 0, 2), Order::Little),
        (15, 0),
    ));

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(
            object(data, 0),
            (0, 31),
            "EPRMDO",
            Value::List(eprmdo),
        )]),
    ))
}

// ---------------------------------------------------------------- Source_Info

fn source_info(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "SIDO";

    let raw = object(data, 0);
    let sido = vec![
        Metadata::new(
            sl(&raw, 0, 1),
            (31, 31),
            "Port Type",
            if flag(sl(&raw, 0, 1), F)? {
                "Guaranteed Capability Port"
            } else {
                "Managed Capability Port"
            },
        ),
        Metadata::reserved(sl(&raw, 1, 8), (30, 24)),
        Metadata::new(
            sl(&raw, 8, 16),
            (23, 16),
            "Port Maximum PDP",
            format!("{}W", num(sl(&raw, 8, 16), F)?),
        ),
        Metadata::new(
            sl(&raw, 16, 24),
            (15, 8),
            "Port Present PDP",
            format!("{}W", num(sl(&raw, 16, 24), F)?),
        ),
        Metadata::new(
            sl(&raw, 24, 32),
            (7, 0),
            "Port Reported PDP",
            format!("{}W", num(sl(&raw, 24, 32), F)?),
        ),
    ];

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(raw, (0, 31), "SIDO", Value::List(sido))]),
    ))
}

// ------------------------------------------------------------------- Revision

fn revision(data: &[u8], bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "RMDO";

    let raw = object(data, 0);
    let rmdo = vec![
        Metadata::new(
            sl(&raw, 0, 4),
            (31, 28),
            "Revision.major",
            num(sl(&raw, 0, 4), F)?,
        ),
        Metadata::new(
            sl(&raw, 4, 8),
            (27, 24),
            "Revision.minor",
            num(sl(&raw, 4, 8), F)?,
        ),
        Metadata::new(
            sl(&raw, 8, 12),
            (23, 20),
            "Version.major",
            num(sl(&raw, 8, 12), F)?,
        ),
        Metadata::new(
            sl(&raw, 12, 16),
            (19, 16),
            "Version.minor",
            num(sl(&raw, 12, 16), F)?,
        ),
        Metadata::reserved(sl(&raw, 16, 32), (15, 0)),
    ];

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(vec![Metadata::new(raw, (0, 31), "RMDO", Value::List(rmdo))]),
    ))
}

// ------------------------------------------------------------- Vendor_Defined

fn vendor_defined(data: &[u8], bit_loc: (u32, u32), ctx: &Ctx<'_>) -> Result<Metadata> {
    const F: &str = "VDO";

    let num_objs = ctx.num_objs();
    let header = vdo::vdm_header(&object(data, 0), (0, 31))?;

    let structured = header.get("VDM Type").and_then(|m| m.value().as_str()) == Some("Structured");
    let command = header
        .get("Command")
        .and_then(|m| m.value().as_str())
        .unwrap_or("")
        .to_owned();
    let command_type = header
        .get("Command Type")
        .and_then(|m| m.value().as_str())
        .unwrap_or("")
        .to_owned();
    let responded = matches!(command_type.as_str(), "ACK" | "NAK" | "BUSY");

    let mut fields = vec![header];

    /// An unrecognised object, reported as raw hex.
    fn opaque(data: &[u8], i: usize, name: String) -> Metadata {
        Metadata::new(
            object(data, i),
            object_loc(i),
            name,
            format!("0x{}", hex_rev_upper(bsl(data, i * 4, (i + 1) * 4))),
        )
    }

    match (structured, command.as_str(), command_type.as_str()) {
        (true, "Discover Identity", "ACK") => {
            fields.push(vdo::id_header_vdo(&object(data, 1), (32, 63), ctx.sop)?);
            fields.push(Metadata::new(
                object(data, 2),
                (64, 95),
                "Cert Stat VDO",
                format!("0x{}", hex_rev_upper(bsl(data, 8, 12))),
            ));

            let pvdo_raw = object(data, 3);
            let pvdo = vec![
                Metadata::new(
                    sl(&pvdo_raw, 0, 16),
                    (31, 16),
                    "USB Product ID",
                    format!("0x{:04X}", num(sl(&pvdo_raw, 0, 16), F)?),
                ),
                Metadata::new(
                    sl(&pvdo_raw, 16, 32),
                    (15, 0),
                    "bcdDevice",
                    format!("0x{:04X}", num(sl(&pvdo_raw, 16, 32), F)?),
                ),
            ];
            fields.push(Metadata::new(
                pvdo_raw,
                (96, 127),
                "Product VDO",
                Value::List(pvdo),
            ));

            let id_header = &fields[1];
            match ctx.sop {
                Sop::SopPrime | Sop::SopDoublePrime => {
                    let product = id_header
                        .get("Product Type (Cable Plug/VPD)")
                        .and_then(|m| m.value().as_str())
                        .unwrap_or("");
                    match product {
                        "Active Cable" => {
                            fields.push(vdo::active_cable_vdo1(&object(data, 4), (128, 159))?);
                            fields.push(vdo::active_cable_vdo2(&object(data, 5), (160, 191))?);
                        }
                        "Passive Cable" => {
                            fields.push(vdo::passive_cable_vdo(&object(data, 4), (128, 159))?)
                        }
                        "VCONN-Powered USB Device (VPD)" => {
                            fields.push(vdo::vpd_vdo(&object(data, 4), (128, 159))?)
                        }
                        _ => {}
                    }
                }
                Sop::Sop => {
                    let ufp = matches!(
                        id_header
                            .get("Product Type (UFP)")
                            .and_then(|m| m.value().as_str())
                            .unwrap_or(""),
                        "PDUSB Hub" | "PDUSB Peripheral"
                    );
                    let dfp = matches!(
                        id_header
                            .get("Product Type (DFP)")
                            .and_then(|m| m.value().as_str())
                            .unwrap_or(""),
                        "PDUSB Hub" | "PDUSB Host" | "Power Brick"
                    );

                    match (ufp, dfp, num_objs) {
                        (true, true, 7) => {
                            fields.push(vdo::ufp_vdo(&object(data, 4), (128, 159))?);
                            fields.push(Metadata::new(
                                object(data, 5),
                                (160, 191),
                                "Padding",
                                "Reserved",
                            ));
                            fields.push(vdo::dfp_vdo(&object(data, 6), (192, 223))?);
                        }
                        (true, true, n) if n > 4 => {
                            for i in 5..n {
                                fields.push(opaque(data, i, format!("Error VDO {i}")));
                            }
                        }
                        (true, false, n) if n > 4 => {
                            fields.push(vdo::ufp_vdo(&object(data, 4), (128, 159))?)
                        }
                        (false, true, n) if n > 4 => {
                            fields.push(vdo::dfp_vdo(&object(data, 4), (128, 159))?)
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        (true, "Discover SVIDs", _) if responded => {
            for i in 1..num_objs {
                let raw = object(data, i);
                let svids = vec![
                    Metadata::new(
                        sl(&raw, 0, 16),
                        (31, 16),
                        format!("SVID {}", i * 2 - 2),
                        format!("0x{:04X}", num(sl(&raw, 0, 16), F)?),
                    ),
                    Metadata::new(
                        sl(&raw, 16, 32),
                        (15, 0),
                        format!("SVID {}", i * 2 - 1),
                        format!("0x{:04X}", num(sl(&raw, 16, 32), F)?),
                    ),
                ];
                fields.push(Metadata::new(
                    raw,
                    object_loc(i),
                    format!("VDO {i}"),
                    Value::List(svids),
                ));
            }
        }
        (true, "Discover Modes", _) if responded => {
            for i in 1..num_objs {
                fields.push(opaque(data, i, format!("Mode {i}")));
            }
        }
        _ => {
            for i in 1..num_objs {
                fields.push(opaque(data, i, format!("VDO {i}")));
            }
        }
    }

    Ok(Metadata::new(
        block_raw(data),
        bit_loc,
        OBJECTS,
        Value::List(fields),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::msg_header;

    fn ctx_for<'a>(header: &'a Metadata, last_pdo: Option<&'a Metadata>) -> Ctx<'a> {
        Ctx {
            sop: Sop::Sop,
            header,
            ex_header: None,
            last_pdo,
            last_ext: None,
            last_rdo: None,
            prop_protocol: false,
        }
    }

    #[test]
    fn source_capabilities_lists_every_advertised_pdo() {
        let header = msg_header(&bits(&[0xA1, 0x21], Order::Little), (0, 15), Sop::Sop).unwrap();
        let ctx = ctx_for(&header, None);
        let data = [0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00];

        let block = source_capabilities(&data, (16, 79), &ctx).unwrap();
        let pdos = block.children().unwrap();
        assert_eq!(pdos.len(), 2);
        assert_eq!(pdos[0].quick_pdo(), Some("F 5.0V@3.0A"));
        assert_eq!(
            pdos[1].get("Voltage").unwrap().value().as_str(),
            Some("9.0V")
        );
    }

    #[test]
    fn a_request_without_capabilities_says_so_rather_than_failing() {
        let header = msg_header(&bits(&[0x42, 0x10], Order::Little), (0, 15), Sop::Sop).unwrap();
        let ctx = ctx_for(&header, None);
        let block = request(&[0x2C, 0xB1, 0x04, 0x10], (16, 47), &ctx).unwrap();
        assert_eq!(block.value().as_str(), Some("Invalid Request Message"));
    }

    #[test]
    fn a_request_resolves_against_stored_capabilities() {
        let caps_header =
            msg_header(&bits(&[0xA1, 0x11], Order::Little), (0, 15), Sop::Sop).unwrap();
        let caps = source_capabilities(
            &[0x2C, 0x91, 0x01, 0x08],
            (16, 47),
            &ctx_for(&caps_header, None),
        )
        .unwrap();
        let last_pdo = Metadata::new("", (0, 0), "PD", Value::List(vec![caps]));

        let header = msg_header(&bits(&[0x42, 0x10], Order::Little), (0, 15), Sop::Sop).unwrap();
        let ctx = ctx_for(&header, Some(&last_pdo));
        let block = request(&[0x2C, 0xB1, 0x04, 0x10], (16, 47), &ctx).unwrap();

        let rdo = block.get("RDO").unwrap();
        assert_eq!(rdo.quick_rdo(), Some("[1] F 5.0V@3.0A"));
    }

    #[test]
    fn an_out_of_range_object_position_is_rejected() {
        let caps_header =
            msg_header(&bits(&[0xA1, 0x11], Order::Little), (0, 15), Sop::Sop).unwrap();
        let caps = source_capabilities(
            &[0x2C, 0x91, 0x01, 0x08],
            (16, 47),
            &ctx_for(&caps_header, None),
        )
        .unwrap();
        let last_pdo = Metadata::new("", (0, 0), "PD", Value::List(vec![caps]));
        let header = msg_header(&bits(&[0x42, 0x10], Order::Little), (0, 15), Sop::Sop).unwrap();
        let ctx = ctx_for(&header, Some(&last_pdo));

        // Object position 0 is not a valid request; the original silently returned
        // the last PDO in the list.
        assert!(matches!(
            request(&[0x2C, 0xB1, 0x04, 0x00], (16, 47), &ctx),
            Err(ParseError::BadObjectPosition { position: 0, .. })
        ));
    }

    #[test]
    fn epr_mode_labels_its_failure_reason() {
        let header = msg_header(&bits(&[0x1A, 0x10], Order::Little), (0, 15), Sop::Sop).unwrap();
        let ctx = ctx_for(&header, None);
        // Action 4 (Enter Failed), data 1 (cable not EPR capable).
        let block = parse("EPR_Mode", &[0x00, 0x00, 0x01, 0x04], (16, 47), &ctx)
            .unwrap()
            .unwrap();
        let eprmdo = block.get("EPRMDO").unwrap();
        assert_eq!(
            eprmdo.get("Action").unwrap().value().as_str(),
            Some("Enter Failed")
        );
        assert_eq!(
            eprmdo.get("Data").unwrap().value().as_str(),
            Some("Cable not EPR Capable")
        );
    }

    #[test]
    fn control_message_types_have_no_body() {
        let header = msg_header(&bits(&[0x03, 0x00], Order::Little), (0, 15), Sop::Sop).unwrap();
        let ctx = ctx_for(&header, None);
        assert!(parse("Accept", &[], (16, 15), &ctx).is_none());
        assert!(parse("GoodCRC", &[], (16, 15), &ctx).is_none());
    }
}
