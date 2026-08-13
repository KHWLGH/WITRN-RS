# usbpd-parser

Parse USB Power Delivery messages into an inspectable field tree.

A Rust port of the [`usbpdparser`](https://pypi.org/project/usbpdparser/) Python
package. No USB dependency — feed it bytes from a meter, a capture file, or a logic
analyser.

```rust
use usbpd_parser::{ParseOptions, Parser, Sop};

let mut parser = Parser::new();
let msg = parser.parse(
    &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
    ParseOptions { sop: Sop::Sop, ..Default::default() },
);

let pdo = msg.get("Data Objects").unwrap().get("PDO 1").unwrap();
assert_eq!(pdo.quick_pdo(), Some("F 5.0V@3.0A"));
assert_eq!(pdo.get("Voltage").unwrap().value().as_str(), Some("5.0V"));
```

Covers the Message Header and Extended Message Header, every PDO and RDO shape
(fixed, battery, variable, PPS, SPR/EPR AVS, and their Sink mirrors), the VDM header
and Discover Identity VDOs, every Data Message body, and every Extended Message body
including reassembly of the chunked ones.

`Parser` carries the conversation state that makes context-dependent messages
decodable; see the crate docs. `Parser::parse` never fails — an undecodable message
still yields a tree, with the bytes under `Error Data`. `Parser::try_parse` reports
the `ParseError` instead.

## Features

- `serde` *(default)* — `Serialize` for `Metadata` and friends.
- `vendor-ids` *(default)* — the USB-IF vendor table behind `vendor_name`.

## Example

```console
$ cargo run --example decode -- A1612C91010E4121A4C1
```

See the [workspace README](../../README.md) for the full picture, including how this
differs from the Python original.

Original Python implementation by [JohnScotttt](https://github.com/JohnScotttt).
LGPL-3.0-or-later.
