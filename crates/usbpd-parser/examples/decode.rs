//! Decode a PD message given as hex on the command line.
//!
//! ```text
//! cargo run --example decode -- A1112C910108
//! cargo run --example decode -- --sop "SOP'" 0x41 0x00
//! ```

use std::process::ExitCode;

use usbpd_parser::{hex_to_bytes, render, to_ansi, ParseOptions, Parser, Sop};

fn main() -> ExitCode {
    let mut sop = Sop::Sop;
    let mut prop_protocol = false;
    let mut level_thr = 1usize;
    let mut hex = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--sop" => match args.next().as_deref().map(str::parse::<Sop>) {
                Some(Ok(parsed)) => sop = parsed,
                _ => return fail("--sop needs one of SOP, SOP', SOP'', SOP'_DEBUG, SOP''_DEBUG"),
            },
            // WITRN meters report PPS objects with widened fields.
            "--prop" => prop_protocol = true,
            "--level" => match args.next().as_deref().map(str::parse::<usize>) {
                Some(Ok(n)) => level_thr = n,
                _ => return fail("--level needs a number"),
            },
            "-h" | "--help" => {
                println!("usage: decode [--sop SOP] [--prop] [--level N] <hex bytes>");
                return ExitCode::SUCCESS;
            }
            other => hex.push(other.to_owned()),
        }
    }

    if hex.is_empty() {
        return fail("no message given; try `decode A1112C910108`");
    }

    let data = match hex_to_bytes(&hex.join(" ")) {
        Ok(data) => data,
        Err(err) => return fail(&err.to_string()),
    };

    let msg = Parser::new().parse(
        &data,
        ParseOptions {
            sop,
            prop_protocol,
            ..Default::default()
        },
    );

    print!("{}", to_ansi(&render(&msg, level_thr)));
    ExitCode::SUCCESS
}

fn fail(message: &str) -> ExitCode {
    eprintln!("decode: {message}");
    ExitCode::FAILURE
}
