//! Identify a connected meter — model, batch and fingerprint — without writing
//! anything to it.
//!
//! ```text
//! cargo run -p witrn-hid --example identify
//! ```

use std::process::ExitCode;

use witrn_hid::{Error, WitrnDev, WITRN_VID};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("identify: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Error> {
    let mut dev = WitrnDev::new();
    let devices = dev.list()?;
    if devices.is_empty() {
        eprintln!("identify: no WITRN device found (vendor {WITRN_VID:#06X})");
        return Ok(());
    }

    // Every meter that is plugged in, each on its own HID path.
    let paths: Vec<_> = devices.iter().map(|d| d.path().to_owned()).collect();
    for path in paths {
        dev.open_path(&path)?;
        let id = dev.identity(2000)?;
        println!("{id}");
        println!("  fingerprint {}", id.fingerprint());
        println!("  signature   {:02X?}", id.signature);
        println!("  port        {}", id.path);
        println!();
        dev.close();
    }
    Ok(())
}
