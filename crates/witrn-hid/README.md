# witrn-hid

Read and decode the HID stream from a WITRN USB power meter.

A Rust port of the [`witrnhid`](https://github.com/JohnScotttt/WITRN_HID_API) Python
package. WITRN meters (K2, U3, C5 …) stream 64-byte HID reports of two kinds:
measurement samples, and captured USB-PD traffic. This crate opens the device, reads
reports, and unpacks both into the field tree
[`usbpd-parser`](../usbpd-parser) defines.

```rust
use witrn_hid::{ReportKind, WitrnDev};

let mut dev = WitrnDev::new();
dev.open()?;                                   // K2; or open_vid_pid / open_path

loop {
    let report = dev.read_data()?;
    match ReportKind::of(report) {
        Some(ReportKind::General) => {
            let (at, msg) = dev.general_unpack(None)?;
            println!("{at}  {}  {}",
                msg.get("VBus").unwrap().value(),
                msg.get("Current").unwrap().value());
        }
        Some(ReportKind::Pd) => {
            let (at, msg) = dev.pd_unpack(None, None, None, None)?;
            println!("{at}  {}", usbpd_parser::to_plain(&usbpd_parser::render(&msg, 1)));
        }
        Some(_) | None => {}
    }
}
```

A general report carries `Ah`, `Wh`, `Rectime`, `Runtime`, `D+`, `D-`,
`Temperature`, `VBus`, `Current`, `Group`, `CC1` and `CC2`.

PD reports are decoded by an embedded `Parser`, so `Source_Capabilities`/`Request`
pairs and chunked extended messages resolve across the stream with no bookkeeping on
your side. If you keep your own message history — for scrubbing back through a
capture — pass the context explicitly and the device's own state is left alone.

## Example

```console
$ cargo run --example monitor -- --list
$ cargo run --example monitor
```

See the [workspace README](../../README.md) for the full picture, including how this
differs from the Python original.

Original Python implementation by [JohnScotttt](https://github.com/JohnScotttt).
LGPL-3.0-or-later.
