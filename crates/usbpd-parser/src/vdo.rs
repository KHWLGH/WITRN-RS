//! Vendor Defined Objects — the VDM header and the VDOs a Discover Identity
//! response carries.

use crate::bits::{flag, num, sl};
use crate::error::Result;
use crate::header::Sop;
use crate::metadata::{Metadata, Value};

/// Speeds shared by the UFP and cable VDOs.
fn usb_highest_speed(bits: &str) -> &'static str {
    match bits {
        "000" => "[USB 2.0] only",
        "001" => "[USB 3.2] Gen1",
        "010" => "[USB 3.2]/[USB 4] Gen2",
        "011" => "[USB4] Gen3",
        "100" => "[USB4] Gen4",
        _ => "Reserved",
    }
}

fn max_vbus_voltage(bits: &str) -> &'static str {
    match bits {
        "00" => "20V",
        "01" => "30V",
        "10" => "40V",
        "11" => "50V",
        _ => "Reserved",
    }
}

fn vbus_current(bits: &str) -> &'static str {
    match bits {
        "01" => "3A",
        "10" => "5A",
        _ => "Reserved",
    }
}

fn plug_to(bits: &str) -> &'static str {
    match bits {
        "10" => "USB Type-C",
        "11" => "Captive",
        _ => "Reserved",
    }
}

// ---------------------------------------------------------------- VDM Header

/// Decode the 32-bit VDM Header, which is structured or unstructured depending on
/// bit 15.
pub(crate) fn vdm_header(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "VDM Header";

    let fields = if flag(sl(raw, 16, 17), F)? {
        let version = match sl(raw, 17, 21) {
            "0000" => "Version 1.0",
            "0100" => "Version 2.0",
            "0101" => "Version 2.1",
            _ => "Reserved",
        };
        let command_type = match sl(raw, 24, 26) {
            "00" => "REQ",
            "01" => "ACK",
            "10" => "NAK",
            "11" => "BUSY",
            _ => "Reserved",
        };
        let command_code = num(sl(raw, 27, 32), F)?;
        let command: Value = match command_code {
            1 => "Discover Identity".into(),
            2 => "Discover SVIDs".into(),
            3 => "Discover Modes".into(),
            4 => "Enter Mode".into(),
            5 => "Exit Mode".into(),
            6 => "Attention".into(),
            7..=15 => "Reserved".into(),
            other => Value::Int(other as i64),
        };

        vec![
            Metadata::new(
                sl(raw, 0, 16),
                (31, 16),
                "SVID",
                format!("0x{:04X}", num(sl(raw, 0, 16), F)?),
            ),
            Metadata::new(sl(raw, 16, 17), (15, 15), "VDM Type", "Structured"),
            Metadata::new(sl(raw, 17, 21), (14, 11), "Structured VDM Version", version),
            Metadata::new(
                sl(raw, 21, 24),
                (10, 8),
                "Object Position",
                num(sl(raw, 21, 24), F)?,
            ),
            Metadata::new(sl(raw, 24, 26), (7, 6), "Command Type", command_type),
            Metadata::reserved(sl(raw, 26, 27), (5, 5)),
            Metadata::new(sl(raw, 27, 32), (4, 0), "Command", command),
        ]
    } else {
        vec![
            Metadata::new(
                sl(raw, 0, 16),
                (31, 16),
                "VID",
                format!("0x{:04X}", num(sl(raw, 0, 16), F)?),
            ),
            Metadata::new(sl(raw, 16, 17), (15, 15), "VDM Type", "Unstructured"),
            Metadata::new(
                sl(raw, 17, 32),
                (14, 0),
                "Vendor Defined",
                format!("0x{:04X}", num(sl(raw, 17, 32), F)?),
            ),
        ]
    };

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// ------------------------------------------------------------ ID Header VDO

/// Decode the ID Header VDO. Which product-type tables apply depends on `sop`.
pub(crate) fn id_header_vdo(raw: &str, bit_loc: (u32, u32), sop: Sop) -> Result<Metadata> {
    const F: &str = "ID Header VDO";

    let mut fields = vec![
        Metadata::new(sl(raw, 0, 1), (31, 31), "USB Host", flag(sl(raw, 0, 1), F)?),
        Metadata::new(
            sl(raw, 1, 2),
            (30, 30),
            "USB Device",
            flag(sl(raw, 1, 2), F)?,
        ),
    ];

    fields.push(match sop {
        Sop::Sop => Metadata::new(
            sl(raw, 2, 5),
            (29, 27),
            "Product Type (UFP)",
            match sl(raw, 2, 5) {
                "000" => "Not a UFP",
                "001" => "PDUSB Hub",
                "010" => "PDUSB Peripheral",
                "011" => "PSD",
                _ => "Reserved",
            },
        ),
        Sop::SopPrime | Sop::SopDoublePrime => Metadata::new(
            sl(raw, 2, 5),
            (29, 27),
            "Product Type (Cable Plug/VPD)",
            match sl(raw, 2, 5) {
                "000" => "Not a Cable Plug/VPD",
                "011" => "Passive Cable",
                "100" => "Active Cable",
                "110" => "VCONN-Powered USB Device (VPD)",
                _ => "Reserved",
            },
        ),
        _ => Metadata::reserved(sl(raw, 2, 5), (29, 27)),
    });

    fields.push(Metadata::new(
        sl(raw, 5, 6),
        (26, 26),
        "Modal Operation Supported",
        flag(sl(raw, 5, 6), F)?,
    ));

    fields.push(if sop == Sop::Sop {
        Metadata::new(
            sl(raw, 6, 9),
            (25, 23),
            "Product Type (DFP)",
            match sl(raw, 6, 9) {
                "000" => "Not a DFP",
                "001" => "PDUSB Hub",
                "010" => "PDUSB Host",
                "011" => "Power Brick",
                _ => "Reserved",
            },
        )
    } else {
        Metadata::reserved(sl(raw, 6, 9), (25, 23))
    });

    fields.extend([
        Metadata::new(
            sl(raw, 9, 11),
            (22, 21),
            "Connector Type",
            match sl(raw, 9, 11) {
                "10" => "USB Type-C Receptacle",
                "11" => "USB Type-C Plug",
                _ => "Reserved",
            },
        ),
        Metadata::reserved(sl(raw, 11, 16), (20, 16)),
        Metadata::new(
            sl(raw, 16, 32),
            (15, 0),
            "USB Vendor ID",
            format!("0x{:04X}", num(sl(raw, 16, 32), F)?),
        ),
    ]);

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// ------------------------------------------------------------------ UFP VDO

pub(crate) fn ufp_vdo(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "UFP VDO";

    let version = match sl(raw, 0, 3) {
        "000" => "Version 1.0",
        "001" => "Version 1.1",
        "010" => "Version 1.2",
        "011" => "Version 1.3",
        _ => "Reserved",
    };

    let device_capability = vec![
        Metadata::new(
            sl(raw, 4, 5),
            (27, 27),
            "[USB 2.0] Device Capable",
            flag(sl(raw, 4, 5), F)?,
        ),
        Metadata::new(
            sl(raw, 5, 6),
            (26, 26),
            "[USB 2.0] Device Capable (Billboard only)",
            flag(sl(raw, 5, 6), F)?,
        ),
        Metadata::new(
            sl(raw, 6, 7),
            (25, 25),
            "[USB 3.2] Device Capable",
            flag(sl(raw, 6, 7), F)?,
        ),
        Metadata::new(
            sl(raw, 7, 8),
            (24, 24),
            "[USB4] Device Capable",
            flag(sl(raw, 7, 8), F)?,
        ),
    ];

    let vconn_required = flag(sl(raw, 24, 25), F)?;
    let vconn_power = if vconn_required {
        match sl(raw, 21, 24) {
            "000" => "1W",
            "001" => "1.5W",
            "010" => "2W",
            "011" => "3W",
            "100" => "4W",
            "101" => "5W",
            "110" => "6W",
            _ => "Reserved",
        }
    } else {
        "Reserved"
    };

    let alternate_modes = vec![
        Metadata::new(
            sl(raw, 26, 27),
            (5, 5),
            "Supports [TBT3]",
            flag(sl(raw, 26, 27), F)?,
        ),
        Metadata::new(
            sl(raw, 27, 28),
            (4, 4),
            "Supports [USB Type-C 2.4] excl. [TBT3]",
            flag(sl(raw, 27, 28), F)?,
        ),
        Metadata::new(
            sl(raw, 28, 29),
            (3, 3),
            "Supports [USB Type-C 2.4] Non-Reconfigurable",
            flag(sl(raw, 28, 29), F)?,
        ),
    ];

    let fields = vec![
        Metadata::new(sl(raw, 0, 3), (31, 29), "UFP VDO Version", version),
        Metadata::reserved(sl(raw, 3, 4), (28, 28)),
        Metadata::new(
            sl(raw, 4, 8),
            (27, 24),
            "Device Capability",
            device_capability,
        ),
        Metadata::new(
            sl(raw, 8, 10),
            (23, 22),
            "Connector Type (Legacy)",
            "Deprecated",
        ),
        Metadata::reserved(sl(raw, 10, 21), (21, 11)),
        Metadata::new(sl(raw, 21, 24), (10, 8), "VCONN Power", vconn_power),
        Metadata::new(sl(raw, 24, 25), (7, 7), "VCONN Required", vconn_required),
        Metadata::new(
            sl(raw, 25, 26),
            (6, 6),
            "VBUS Required",
            !flag(sl(raw, 25, 26), F)?,
        ),
        Metadata::new(sl(raw, 26, 29), (5, 3), "Alternate Modes", alternate_modes),
        Metadata::new(
            sl(raw, 29, 32),
            (2, 0),
            "USB Highest Speed",
            usb_highest_speed(sl(raw, 29, 32)),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// ------------------------------------------------------------------ DFP VDO

pub(crate) fn dfp_vdo(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "DFP VDO";

    let version = match sl(raw, 0, 3) {
        "000" => "Version 1.0",
        "001" => "Version 1.1",
        "010" => "Version 1.2",
        _ => "Reserved",
    };

    let host_capability = vec![
        Metadata::new(
            sl(raw, 5, 6),
            (26, 26),
            "[USB 2.0] Host Capable",
            flag(sl(raw, 5, 6), F)?,
        ),
        Metadata::new(
            sl(raw, 6, 7),
            (25, 25),
            "[USB 3.2] Host Capable",
            flag(sl(raw, 6, 7), F)?,
        ),
        Metadata::new(
            sl(raw, 7, 8),
            (24, 24),
            "[USB4] Host Capable",
            flag(sl(raw, 7, 8), F)?,
        ),
    ];

    let fields = vec![
        Metadata::new(sl(raw, 0, 3), (31, 29), "DFP VDO Version", version),
        Metadata::reserved(sl(raw, 3, 5), (28, 27)),
        Metadata::new(sl(raw, 5, 8), (26, 24), "Host Capability", host_capability),
        Metadata::new(
            sl(raw, 8, 10),
            (23, 22),
            "Connector Type (Legacy)",
            "Deprecated",
        ),
        Metadata::reserved(sl(raw, 10, 27), (21, 5)),
        Metadata::new(
            sl(raw, 27, 32),
            (4, 0),
            "Port Number",
            num(sl(raw, 27, 32), F)?,
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// -------------------------------------------------------- Passive Cable VDO

pub(crate) fn passive_cable_vdo(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "Passive Cable VDO";

    let latency = match sl(raw, 15, 19) {
        "0001" => "<10ns (~1m)",
        "0010" => "10ns to 20ns (~2m)",
        "0011" => "20ns to 30ns (~3m)",
        "0100" => "30ns to 40ns (~4m)",
        "0101" => "40ns to 50ns (~5m)",
        "0110" => "50ns to 60ns (~6m)",
        "0111" => "60ns to 70ns (~7m)",
        "1000" => "> 70ns (>~7m)",
        _ => "Reserved",
    };

    let termination = match sl(raw, 19, 21) {
        "00" => "VCONN not required",
        "01" => "VCONN required",
        _ => "Reserved",
    };

    let fields = vec![
        Metadata::new(
            sl(raw, 0, 4),
            (31, 28),
            "HW Version",
            num(sl(raw, 0, 4), F)?,
        ),
        Metadata::new(
            sl(raw, 4, 8),
            (27, 24),
            "Firmware Version",
            num(sl(raw, 4, 8), F)?,
        ),
        Metadata::new(
            sl(raw, 8, 11),
            (23, 21),
            "VDO Version",
            if sl(raw, 8, 11) == "000" {
                "Version 1.0"
            } else {
                "Reserved"
            },
        ),
        Metadata::reserved(sl(raw, 11, 12), (20, 20)),
        Metadata::new(
            sl(raw, 12, 14),
            (19, 18),
            "USB Type-C plug to USB Type-C/Captive (Passive Cable)",
            plug_to(sl(raw, 12, 14)),
        ),
        Metadata::new(
            sl(raw, 14, 15),
            (17, 17),
            "EPR Capable (Passive Cable)",
            flag(sl(raw, 14, 15), F)?,
        ),
        Metadata::new(
            sl(raw, 15, 19),
            (16, 13),
            "Cable Latency (Passive Cable)",
            latency,
        ),
        Metadata::new(
            sl(raw, 19, 21),
            (12, 11),
            "Cable Termination Type (Passive Cable)",
            termination,
        ),
        Metadata::new(
            sl(raw, 21, 23),
            (10, 9),
            "Maximum VBUS Voltage (Passive Cable)",
            max_vbus_voltage(sl(raw, 21, 23)),
        ),
        Metadata::reserved(sl(raw, 23, 25), (8, 7)),
        Metadata::new(
            sl(raw, 25, 27),
            (6, 5),
            "VBUS Current Handling Capability (Passive Cable)",
            vbus_current(sl(raw, 25, 27)),
        ),
        Metadata::reserved(sl(raw, 27, 29), (4, 3)),
        Metadata::new(
            sl(raw, 29, 32),
            (2, 0),
            "USB Highest Speed (Passive Cable)",
            usb_highest_speed(sl(raw, 29, 32)),
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// ------------------------------------------------------- Active Cable VDO 1

pub(crate) fn active_cable_vdo1(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "Active Cable VDO 1";

    let latency = match sl(raw, 15, 19) {
        "0001" => "<10ns (~1m)",
        "0010" => "10ns to 20ns (~2m)",
        "0011" => "20ns to 30ns (~3m)",
        "0100" => "30ns to 40ns (~4m)",
        "0101" => "40ns to 50ns (~5m)",
        "0110" => "50ns to 60ns (~6m)",
        "0111" => "60ns to 70ns (~7m)",
        "1000" => "1000ns (~100m)",
        "1001" => "2000ns (~200m)",
        "1010" => "3000ns (~300m)",
        _ => "Reserved",
    };

    let termination = match sl(raw, 19, 21) {
        "10" => "One end Active, one end passive, VCONN required",
        "11" => "Both ends Active, VCONN required",
        _ => "Reserved",
    };

    let sbu_supported = !flag(sl(raw, 23, 24), F)?;

    let mut fields = vec![
        Metadata::new(
            sl(raw, 0, 4),
            (31, 28),
            "HW Version",
            num(sl(raw, 0, 4), F)?,
        ),
        Metadata::new(
            sl(raw, 4, 8),
            (27, 24),
            "Firmware Version",
            num(sl(raw, 4, 8), F)?,
        ),
        Metadata::new(
            sl(raw, 8, 11),
            (23, 21),
            "VDO Version",
            if sl(raw, 8, 11) == "000" {
                "Version 1.0"
            } else {
                "Reserved"
            },
        ),
        Metadata::reserved(sl(raw, 11, 12), (20, 20)),
        Metadata::new(
            sl(raw, 12, 14),
            (19, 18),
            "USB Type-C plug to USB Type-C/Captive",
            plug_to(sl(raw, 12, 14)),
        ),
        Metadata::new(
            sl(raw, 14, 15),
            (17, 17),
            "EPR Capable (Active Cable)",
            flag(sl(raw, 14, 15), F)?,
        ),
        Metadata::new(sl(raw, 15, 19), (16, 13), "Cable Latency", latency),
        Metadata::new(
            sl(raw, 19, 21),
            (12, 11),
            "Cable Termination Type (Active Cable)",
            termination,
        ),
        Metadata::new(
            sl(raw, 21, 23),
            (10, 9),
            "Maximum VBUS Voltage (Active Cable)",
            max_vbus_voltage(sl(raw, 21, 23)),
        ),
        Metadata::new(sl(raw, 23, 24), (8, 8), "SBU Supported", sbu_supported),
    ];

    fields.push(if sbu_supported {
        Metadata::new(
            sl(raw, 24, 25),
            (7, 7),
            "SBU Type",
            if flag(sl(raw, 24, 25), F)? {
                "SBU is active"
            } else {
                "SBU is passive"
            },
        )
    } else {
        Metadata::reserved(sl(raw, 24, 25), (7, 7))
    });

    fields.extend([
        Metadata::new(
            sl(raw, 25, 27),
            (6, 5),
            "VBUS Current Handling Capability (Active Cable)",
            vbus_current(sl(raw, 25, 27)),
        ),
        Metadata::new(
            sl(raw, 27, 28),
            (4, 4),
            "VBUS Through Cable",
            flag(sl(raw, 27, 28), F)?,
        ),
        Metadata::new(
            sl(raw, 28, 29),
            (3, 3),
            "SOP'' Controller Present",
            flag(sl(raw, 28, 29), F)?,
        ),
        Metadata::new(
            sl(raw, 29, 32),
            (2, 0),
            "USB Highest Speed (Active Cable)",
            usb_highest_speed(sl(raw, 29, 32)),
        ),
    ]);

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// ------------------------------------------------------- Active Cable VDO 2

pub(crate) fn active_cable_vdo2(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "Active Cable VDO 2";

    let u3_cld_power = match sl(raw, 17, 20) {
        "000" => ">10mW",
        "001" => "5-10mW",
        "010" => "1-5mW",
        "011" => "0.5-1mW",
        "100" => "0.2-0.5mW",
        "101" => "50-200\u{3bc}W",
        "110" => "<50\u{3bc}W",
        _ => "Reserved",
    };

    let fields = vec![
        Metadata::new(
            sl(raw, 0, 8),
            (31, 24),
            "Maximum Operating Temperature",
            format!("{}\u{b0}C", num(sl(raw, 0, 8), F)?),
        ),
        Metadata::new(
            sl(raw, 8, 16),
            (23, 16),
            "Shutdown Temperature",
            format!("{}\u{b0}C", num(sl(raw, 8, 16), F)?),
        ),
        Metadata::reserved(sl(raw, 16, 17), (15, 15)),
        Metadata::new(sl(raw, 17, 20), (14, 12), "U3/CLd Power", u3_cld_power),
        Metadata::new(
            sl(raw, 20, 21),
            (11, 11),
            "U3 to U0 transition mode",
            if flag(sl(raw, 20, 21), F)? {
                "U3 to U0 through U3S"
            } else {
                "U3 to U0 direct"
            },
        ),
        Metadata::new(
            sl(raw, 21, 22),
            (10, 10),
            "Physical connection",
            if flag(sl(raw, 21, 22), F)? {
                "Optical"
            } else {
                "Copper"
            },
        ),
        Metadata::new(
            sl(raw, 22, 23),
            (9, 9),
            "Active element",
            if flag(sl(raw, 22, 23), F)? {
                "Active Re-timer"
            } else {
                "Active Re-driver"
            },
        ),
        Metadata::new(
            sl(raw, 23, 24),
            (8, 8),
            "USB4 Supported",
            !flag(sl(raw, 23, 24), F)?,
        ),
        Metadata::new(
            sl(raw, 24, 26),
            (7, 6),
            "USB 2.0 Hub Hops Consumed",
            num(sl(raw, 24, 26), F)?,
        ),
        Metadata::new(
            sl(raw, 26, 27),
            (5, 5),
            "USB 2.0 Supported",
            !flag(sl(raw, 26, 27), F)?,
        ),
        Metadata::new(
            sl(raw, 27, 28),
            (4, 4),
            "USB 3.2 Supported",
            !flag(sl(raw, 27, 28), F)?,
        ),
        // The original lost this value to a missing comma, which glued the label and
        // the value into one field name.
        Metadata::new(
            sl(raw, 28, 29),
            (3, 3),
            "USB Lanes Supported",
            if flag(sl(raw, 28, 29), F)? {
                "Two lanes"
            } else {
                "One lane"
            },
        ),
        Metadata::new(
            sl(raw, 29, 30),
            (2, 2),
            "Optically Isolated Active Cable",
            flag(sl(raw, 29, 30), F)?,
        ),
        Metadata::new(
            sl(raw, 30, 31),
            (1, 1),
            "USB4 Asymmetric Mode Supported",
            flag(sl(raw, 30, 31), F)?,
        ),
        Metadata::new(
            sl(raw, 31, 32),
            (0, 0),
            "USB Gen",
            if flag(sl(raw, 31, 32), F)? {
                "Gen 2 or higher"
            } else {
                "Gen 1"
            },
        ),
    ];

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

// ------------------------------------------------------------------ VPD VDO

pub(crate) fn vpd_vdo(raw: &str, bit_loc: (u32, u32)) -> Result<Metadata> {
    const F: &str = "VPD VDO";

    let charge_through = flag(sl(raw, 31, 32), F)?;

    let mut fields = vec![
        Metadata::new(
            sl(raw, 0, 4),
            (31, 28),
            "HW Version",
            num(sl(raw, 0, 4), F)?,
        ),
        Metadata::new(
            sl(raw, 4, 8),
            (27, 24),
            "Firmware Version",
            num(sl(raw, 4, 8), F)?,
        ),
        Metadata::new(
            sl(raw, 8, 11),
            (23, 21),
            "VDO Version",
            if sl(raw, 8, 11) == "000" {
                "Version 1.0"
            } else {
                "Reserved"
            },
        ),
        Metadata::reserved(sl(raw, 11, 15), (20, 17)),
        Metadata::new(
            sl(raw, 15, 17),
            (16, 15),
            "Maximum VBUS Voltage",
            max_vbus_voltage(sl(raw, 15, 17)),
        ),
    ];

    if charge_through {
        fields.extend([
            Metadata::new(
                sl(raw, 17, 18),
                (14, 14),
                "Charge Through Current Support",
                if flag(sl(raw, 17, 18), F)? {
                    "5A Capable"
                } else {
                    "3A Capable"
                },
            ),
            Metadata::reserved(sl(raw, 18, 19), (13, 13)),
            Metadata::new(
                sl(raw, 19, 25),
                (12, 7),
                "VBUS Impedance",
                format!("{}m\u{3a9}", num(sl(raw, 19, 25), F)? * 2),
            ),
            Metadata::new(
                sl(raw, 25, 31),
                (6, 1),
                "Ground Impedance",
                format!("{}m\u{3a9}", num(sl(raw, 25, 31), F)?),
            ),
        ]);
    } else {
        fields.extend([
            Metadata::new(
                sl(raw, 17, 18),
                (14, 14),
                "Charge Through Current Support",
                "Reserved",
            ),
            Metadata::reserved(sl(raw, 18, 19), (13, 13)),
            Metadata::new(sl(raw, 19, 25), (12, 7), "VBUS Impedance", "Reserved"),
            Metadata::new(sl(raw, 25, 31), (6, 1), "Ground Impedance", "Reserved"),
        ]);
    }

    fields.push(Metadata::new(
        sl(raw, 31, 32),
        (0, 0),
        "Charge Through Support",
        charge_through,
    ));

    Ok(Metadata::new(raw, bit_loc, F, Value::List(fields)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::{bits, Order};

    #[test]
    fn decodes_a_structured_discover_identity_request() {
        // SVID 0xFF00, structured, version 2.0, REQ, command 1.
        let raw = bits(&[0x01, 0x80, 0x00, 0xFF], Order::Little);
        let h = vdm_header(&raw, (0, 31)).unwrap();
        assert_eq!(h.get("SVID").unwrap().value().as_str(), Some("0xFF00"));
        assert_eq!(
            h.get("VDM Type").unwrap().value().as_str(),
            Some("Structured")
        );
        assert_eq!(
            h.get("Command").unwrap().value().as_str(),
            Some("Discover Identity")
        );
        assert_eq!(h.get("Command Type").unwrap().value().as_str(), Some("REQ"));
    }

    #[test]
    fn an_unstructured_vdm_header_reports_a_vid() {
        let raw = bits(&[0x34, 0x12, 0x00, 0x05], Order::Little);
        let h = vdm_header(&raw, (0, 31)).unwrap();
        assert_eq!(
            h.get("VDM Type").unwrap().value().as_str(),
            Some("Unstructured")
        );
        assert!(h.get("VID").is_some());
    }

    #[test]
    fn active_cable_vdo2_keeps_its_lane_count() {
        // Bit 3 set: two lanes. The original produced a field literally named
        // "USB Lanes SupportedTwo lanes" carrying no value.
        let raw = bits(&[0x08, 0x00, 0x00, 0x00], Order::Little);
        let vdo = active_cable_vdo2(&raw, (0, 31)).unwrap();
        let lanes = vdo.get("USB Lanes Supported").unwrap();
        assert_eq!(lanes.value().as_str(), Some("Two lanes"));

        let raw = bits(&[0x00, 0x00, 0x00, 0x00], Order::Little);
        let vdo = active_cable_vdo2(&raw, (0, 31)).unwrap();
        assert_eq!(
            vdo.get("USB Lanes Supported").unwrap().value().as_str(),
            Some("One lane")
        );
    }

    #[test]
    fn id_header_product_type_tables_follow_the_sop() {
        let raw = bits(&[0x1D, 0x00, 0x00, 0x50], Order::Little);
        assert!(id_header_vdo(&raw, (0, 31), Sop::Sop)
            .unwrap()
            .get("Product Type (UFP)")
            .is_some());
        assert!(id_header_vdo(&raw, (0, 31), Sop::SopPrime)
            .unwrap()
            .get("Product Type (Cable Plug/VPD)")
            .is_some());
        assert!(id_header_vdo(&raw, (0, 31), Sop::SopDoublePrime)
            .unwrap()
            .get("Product Type (Cable Plug/VPD)")
            .is_some());
    }

    #[test]
    fn vpd_impedances_read_as_reserved_without_charge_through() {
        let raw = bits(&[0x00, 0xFF, 0x00, 0x00], Order::Little);
        let vdo = vpd_vdo(&raw, (0, 31)).unwrap();
        assert_eq!(
            vdo.get("Charge Through Support").unwrap().value().as_bool(),
            Some(false)
        );
        assert_eq!(
            vdo.get("VBUS Impedance").unwrap().value().as_str(),
            Some("Reserved")
        );
    }
}
