//! Stream live readings and PD traffic from a connected WITRN meter.
//!
//! ```text
//! cargo run --example monitor            # first WITRN device found
//! cargo run --example monitor -- --list  # show what is connected
//! ```

use std::process::ExitCode;

use usbpd_parser::{render, to_ansi};
use witrn_hid::{fields, Error, ReportKind, WitrnDev, WITRN_VID};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("monitor: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Error> {
    let mut dev = WitrnDev::new();

    let devices = dev.list()?;
    if devices.is_empty() {
        eprintln!("monitor: no WITRN device found (vendor {WITRN_VID:#06X})");
        return Ok(());
    }

    if std::env::args().any(|a| a == "--list") {
        for info in &devices {
            println!(
                "{:04X}:{:04X}  {}",
                info.vendor_id(),
                info.product_id(),
                info.product_string().unwrap_or("?")
            );
        }
        return Ok(());
    }

    let target = &devices[0];
    println!(
        "connected: {} ({:04X}:{:04X})\n",
        target.product_string().unwrap_or("WITRN"),
        target.vendor_id(),
        target.product_id()
    );
    dev.open_vid_pid(target.vendor_id(), target.product_id())?;

    loop {
        // A one-second timeout keeps Ctrl-C responsive on an idle link.
        match dev.read_data_timeout(1000) {
            Ok([]) => continue,
            Ok(_) => {}
            Err(Error::ShortReport { .. }) => continue,
            Err(err) => return Err(err),
        }

        let kind = ReportKind::of(dev.data().unwrap_or_default());
        match kind {
            Some(ReportKind::General) => {
                let (at, msg) = dev.general_unpack(None)?;
                let field = |name: &str| {
                    msg.get(name)
                        .map(|m| m.value().to_string())
                        .unwrap_or_else(|| "-".into())
                };
                println!(
                    "{at}  {:>12}  {:>10}  {:>10}  CC1 {:>6}  CC2 {:>6}  {}",
                    field(fields::VBUS),
                    field(fields::CURRENT),
                    field(fields::TEMPERATURE),
                    field(fields::CC1),
                    field(fields::CC2),
                    field(fields::RUNTIME),
                );
            }
            Some(ReportKind::Pd) => {
                let (at, msg) = dev.pd_unpack(None, None, None, None)?;
                println!("\n{at}  PD");
                print!("{}", to_ansi(&render(&msg, 1)));
                println!();
            }
            // A report kind this build does not know about, or none at all.
            Some(_) | None => {}
        }
    }
}
