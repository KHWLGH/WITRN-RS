//! A whole power negotiation, end to end, the way it arrives off a real link.
//!
//! Messages are built from header and data-object *words* rather than hex literals,
//! so the bit layout under test is the parser's, not the test author's arithmetic.

use usbpd_parser::{is_pdo, is_rdo, provides_ext, ParseOptions, Parser, Sop};

/// Assemble a PD message from its 16-bit header and 32-bit data objects.
fn message(header: u16, objects: &[u32]) -> Vec<u8> {
    let mut out = header.to_le_bytes().to_vec();
    for word in objects {
        out.extend_from_slice(&word.to_le_bytes());
    }
    out
}

/// Assemble an extended PD message: header, extended header, then the data block
/// padded out to whole data objects.
fn extended(header: u16, ex_header: u16, block: &[u8], objects: usize) -> Vec<u8> {
    let mut out = header.to_le_bytes().to_vec();
    out.extend_from_slice(&ex_header.to_le_bytes());
    out.extend_from_slice(block);
    out.resize(2 + objects * 4, 0);
    out
}

/// `Extended | NumObjs | MessageID | PowerRole | SpecRev | DataRole | Type`.
const fn header(ext: u16, objs: u16, id: u16, source: u16, dfp: u16, ty: u16) -> u16 {
    ext << 15 | objs << 12 | id << 9 | source << 8 | 0b10 << 6 | dfp << 5 | ty
}

/// The six PDOs of a typical 65 W GaN charger.
const PDOS: [u32; 6] = [
    0x0E01_912C, // Fixed  5 V  / 3.00 A, unconstrained, USB comms, DRD
    0x0002_D12C, // Fixed  9 V  / 3.00 A
    0x0003_C12C, // Fixed 12 V  / 3.00 A
    0x0004_B12C, // Fixed 15 V  / 3.00 A
    0x0006_4145, // Fixed 20 V  / 3.25 A
    0xC1A4_2141, // PPS  3.3-21 V / 3.25 A
];

fn opts<'a>() -> ParseOptions<'a> {
    ParseOptions {
        sop: Sop::Sop,
        ..Default::default()
    }
}

#[test]
fn a_charger_advertises_every_pdo_it_supports() {
    let msg = Parser::new().parse(&message(header(0, 6, 0, 1, 1, 1), &PDOS), opts());

    let objects = msg.get("Data Objects").unwrap();
    let pdos = objects.children().unwrap();
    assert_eq!(pdos.len(), 6);

    let summaries: Vec<_> = pdos.iter().map(|p| p.quick_pdo().unwrap()).collect();
    assert_eq!(
        summaries,
        [
            "F 5.0V@3.0A",
            "F 9.0V@3.0A",
            "F 12.0V@3.0A",
            "F 15.0V@3.0A",
            "F 20.0V@3.25A",
            "P 3.3-21.0V@3.25A",
        ]
    );

    // Flags on the first PDO, which is the one that carries them by spec.
    let first = &pdos[0];
    assert_eq!(
        first.get("Unconstrained Power").unwrap().value().as_bool(),
        Some(true)
    );
    assert_eq!(
        first
            .get("USB Communications Capable")
            .unwrap()
            .value()
            .as_bool(),
        Some(true)
    );
    assert_eq!(
        first.get("Dual-Role Data").unwrap().value().as_bool(),
        Some(true)
    );
}

#[test]
fn a_pps_request_resolves_against_the_advertised_pdo() {
    let mut parser = Parser::new();
    parser.parse(&message(header(0, 6, 0, 1, 1, 1), &PDOS), opts());

    // Object position 6, 15.0 V, 3.00 A, USB comms capable.
    let request = parser.parse(&message(header(0, 1, 1, 0, 0, 2), &[0x6205_DC3C]), opts());

    let rdo = request.get("Data Objects").unwrap().get("RDO").unwrap();
    assert_eq!(
        rdo.get("Object Position").unwrap().value().as_int(),
        Some(6)
    );
    assert_eq!(
        rdo.get("Output Voltage").unwrap().value().as_str(),
        Some("15.0V")
    );
    assert_eq!(
        rdo.get("Operating Current").unwrap().value().as_str(),
        Some("3.0A")
    );
    assert_eq!(rdo.quick_rdo(), Some("[6] P 15.0V@3.0A"));

    // The RDO carries the PDO it resolved against.
    assert_eq!(
        rdo.pdo()
            .unwrap()
            .get("APDO Type")
            .unwrap()
            .value()
            .as_str(),
        Some("SPR PPS")
    );
}

#[test]
fn a_status_message_reads_cl_cv_because_a_pps_request_is_in_force() {
    let mut parser = Parser::new();
    parser.parse(&message(header(0, 6, 0, 1, 1, 1), &PDOS), opts());
    parser.parse(&message(header(0, 1, 1, 0, 0, 2), &[0x6205_DC3C]), opts());

    // SDB: 30 °C internal, external power, CL/CV set (bit 4), temperature normal, S0.
    let sdb = [30u8, 0x02, 0x00, 0x10, 0x01, 0x00, 0x01];
    let status = parser.parse(&extended(header(1, 3, 2, 1, 1, 2), 0x8007, &sdb, 3), opts());

    let sdb = status.get("SDB").unwrap();
    assert_eq!(
        sdb.get("Internal Temp").unwrap().value().as_str(),
        Some("30\u{b0}C")
    );
    assert_eq!(
        sdb.get("Temperature Status").unwrap().value().as_str(),
        Some("Normal")
    );
    assert_eq!(
        sdb.get("Present Input")
            .unwrap()
            .get("External Power")
            .unwrap()
            .value()
            .as_bool(),
        Some(true)
    );
    // The flag is only labelled because the RDO on record names a PPS supply.
    assert_eq!(
        sdb.get("Event Flags")
            .unwrap()
            .get("CL/CV Mode")
            .unwrap()
            .value()
            .as_str(),
        Some("CL")
    );
    assert_eq!(
        sdb.get("Power State Change")
            .unwrap()
            .get("New Power State")
            .unwrap()
            .value()
            .as_str(),
        Some("S0")
    );
}

#[test]
fn a_status_message_without_a_request_on_record_cannot_be_decoded() {
    let sdb = [30u8, 0x02, 0x00, 0x10, 0x01, 0x00, 0x01];
    let bytes = extended(header(1, 3, 2, 1, 1, 2), 0x8007, &sdb, 3);

    // No preceding Request: the CL/CV flag has no meaning, so the body is reported raw.
    let msg = Parser::new().parse(&bytes, opts());
    assert!(msg.get("Error Data").is_some());
    assert!(Parser::new().try_parse(&bytes, opts()).is_err());
}

#[test]
fn the_negotiation_updates_exactly_the_state_each_message_owns() {
    let mut parser = Parser::new();

    let caps = parser.parse(&message(header(0, 6, 0, 1, 1, 1), &PDOS), opts());
    assert!(is_pdo(&caps) && !is_rdo(&caps) && !provides_ext(&caps));
    assert!(parser.last_pdo().is_some());
    assert!(parser.last_rdo().is_none());

    let request = parser.parse(&message(header(0, 1, 1, 0, 0, 2), &[0x6205_DC3C]), opts());
    assert!(is_rdo(&request) && !is_pdo(&request));
    assert!(parser.last_rdo().is_some());

    // Accept and PS_RDY are control messages and change nothing.
    parser.parse(&message(header(0, 0, 2, 1, 1, 0b00011), &[]), opts());
    parser.parse(&message(header(0, 0, 3, 1, 1, 0b00110), &[]), opts());
    assert!(parser.last_pdo().is_some());
    assert!(parser.last_rdo().is_some());
}

#[test]
fn every_control_message_decodes_to_its_name() {
    let mut parser = Parser::new();
    for (ty, name) in [
        (0b00001u16, "GoodCRC"),
        (0b00011, "Accept"),
        (0b00100, "Reject"),
        (0b00110, "PS_RDY"),
        (0b01101, "Soft_Reset"),
        (0b10010, "Get_Status"),
        (0b11000, "Get_Revision"),
    ] {
        let msg = parser.parse(&message(header(0, 0, 0, 1, 1, ty), &[]), opts());
        assert_eq!(
            msg.get("Message Header")
                .unwrap()
                .get("Message Type")
                .unwrap()
                .value()
                .as_str(),
            Some(name)
        );
        // A control message is header-only.
        assert_eq!(msg.children().unwrap().len(), 2);
    }
}

#[test]
fn a_cable_responds_to_discover_identity_over_sop_prime() {
    let mut parser = Parser::new();

    // ACK: VDM header, ID header (passive cable), Cert Stat, Product, Passive Cable VDO.
    let vdm_header = 0xFF01_A041u32; // SVID 0xFF00, structured v2.0, ACK, Discover Identity
    let id_header = 0x1860_0000u32 | 0x2109; // passive cable, Type-C plug, VID 0x2109
    let objects = [vdm_header, id_header, 0x0000_0000, 0x0001_0100, 0x0308_2032];

    let msg = parser.parse(
        &message(header(0, 5, 0, 0, 0, 0b01111), &objects),
        ParseOptions {
            sop: Sop::SopPrime,
            ..Default::default()
        },
    );

    let block = msg.get("Data Objects").unwrap();
    assert_eq!(
        block
            .get("VDM Header")
            .unwrap()
            .get("Command")
            .unwrap()
            .value()
            .as_str(),
        Some("Discover Identity")
    );
    let id = block.get("ID Header VDO").unwrap();
    assert_eq!(
        id.get("Product Type (Cable Plug/VPD)")
            .unwrap()
            .value()
            .as_str(),
        Some("Passive Cable")
    );
    assert_eq!(
        id.get("USB Vendor ID").unwrap().value().as_str(),
        Some("0x2109")
    );
    // The cable VDO is only decoded because the ID header said "Passive Cable".
    assert!(block.get("Passive Cable VDO").is_some());
}

#[test]
fn sop_prime_headers_use_the_cable_plug_labels() {
    let msg = Parser::new().parse(
        &message(header(0, 0, 0, 1, 0, 0b00001), &[]),
        ParseOptions {
            sop: Sop::SopPrime,
            ..Default::default()
        },
    );
    let h = msg.get("Message Header").unwrap();
    assert_eq!(
        h.get("Cable Plug").unwrap().value().as_str(),
        Some("Cable Plug or VPD")
    );
    assert!(h.get("Port Power Role").is_none());
    assert!(h.get("Port Data Role").is_none());
}

#[test]
fn parsing_the_same_stream_twice_gives_the_same_tree() {
    let bytes = message(header(0, 6, 0, 1, 1, 1), &PDOS);
    assert_eq!(
        Parser::new().parse(&bytes, opts()),
        Parser::new().parse(&bytes, opts())
    );
}

#[test]
fn a_truncated_message_never_panics_at_any_length() {
    let full = message(header(0, 6, 0, 1, 1, 1), &PDOS);
    for len in 0..=full.len() {
        let msg = Parser::new().parse(&full[..len], opts());
        assert!(matches!(msg.field(), "PD"));
    }
}

/// A Request whose data object is short used to decode anyway, reading its trailing
/// current fields from however many bits were left.
#[test]
fn a_truncated_request_is_reported_rather_than_decoded_from_fewer_bits() {
    let caps = message(header(0, 1, 0, 1, 1, 1), &[PDOS[0]]);
    let request = message(header(0, 1, 1, 0, 0, 2), &[0x1004_B12C]);

    for len in 2..request.len() {
        let mut parser = Parser::new();
        parser.parse(&caps, opts());
        let short = parser.parse(&request[..len], opts());
        assert!(
            short.get("Error Data").is_some(),
            "a {len}-byte Request decoded to {:?}",
            short
                .get("Data Objects")
                .and_then(|d| d.get("RDO"))
                .map(|r| r.quick_rdo())
        );
    }

    // The whole message still decodes.
    let mut parser = Parser::new();
    parser.parse(&caps, opts());
    let whole = parser.parse(&request, opts());
    assert_eq!(
        whole
            .get("Data Objects")
            .unwrap()
            .get("RDO")
            .unwrap()
            .quick_rdo(),
        Some("[1] F 5.0V@3.0A")
    );
}

/// Every extended message type, over the `Data Size` / `Chunked` / `Chunk Number`
/// combinations the wire allows. A `Data Size` of zero used to underflow the byte
/// range arithmetic: a panic under debug assertions, garbage without them.
#[test]
fn no_extended_header_combination_panics() {
    for ty in 0..32u16 {
        for size in [0u16, 1, 2, 3, 4, 8, 26, 260, 511] {
            for chunked in [false, true] {
                for chunk_no in [0u16, 1, 15] {
                    let ex = u16::from(chunked) << 15 | chunk_no << 11 | size;
                    let mut parser = Parser::new();
                    for objs in [1u16, 3, 7] {
                        let bytes = extended(
                            header(1, objs, 0, 1, 1, ty),
                            ex,
                            b"\x01\x80\x00\xFF\xAA\xBB\xCC\xDD",
                            objs as usize,
                        );
                        let msg = parser.parse(&bytes, opts());
                        assert_eq!(
                            msg.field(),
                            "PD",
                            "type {ty}, size {size}, chunked {chunked}, chunk {chunk_no}"
                        );
                    }
                }
            }
        }
    }
}

/// A stream of chunks must not grow the parser's state without bound — the buffer
/// used to be re-copied, in full, on every message.
#[test]
fn a_long_chunk_stream_does_not_grow_the_parser_without_bound() {
    // Security_Request, chunked, claiming less than the chunks will add up to.
    let body = |chunk_no: u16, fill: u8| {
        let ex = 1u16 << 15 | chunk_no << 11 | 64;
        extended(header(1, 7, 0, 1, 1, 0b01000), ex, &[fill; 26], 7)
    };

    let mut parser = Parser::new();
    parser.parse(&body(0, 0xCD), opts());
    // Chunk Number is four bits, so this is the longest run the wire allows.
    for chunk_no in 1..16u16 {
        parser.parse(&body(chunk_no, 0xAB), opts());
    }

    let accumulated = parser
        .last_ext()
        .and_then(|m| m.get("SRQDB"))
        .map(|m| m.full_raw().as_str().len() / 8)
        .unwrap_or(0);
    assert!(
        accumulated <= 64,
        "accumulated {accumulated} bytes for a 64-byte message"
    );
}

/// Repeating a chunk does not continue the reassembly, so it cannot be used to keep
/// appending to it either.
#[test]
fn a_repeated_chunk_does_not_extend_the_message_in_flight() {
    let body = |chunk_no: u16| {
        let ex = 1u16 << 15 | chunk_no << 11 | 511;
        extended(header(1, 7, 0, 1, 1, 0b01000), ex, &[0xAB; 26], 7)
    };

    let mut parser = Parser::new();
    parser.parse(&body(0), opts());
    parser.parse(&body(1), opts());
    let after_one = parser
        .last_ext()
        .and_then(|m| m.get("SRQDB"))
        .map(|m| m.full_raw().as_str().len() / 8)
        .unwrap();

    for _ in 0..1_000 {
        let msg = parser.parse(&body(1), opts());
        assert!(
            msg.get("Error Data").is_some(),
            "a repeated chunk was accepted"
        );
    }

    let after_many = parser
        .last_ext()
        .and_then(|m| m.get("SRQDB"))
        .map(|m| m.full_raw().as_str().len() / 8)
        .unwrap();
    assert_eq!(
        after_one, after_many,
        "the reassembly grew on a rejected chunk"
    );
}

#[test]
fn arbitrary_bytes_never_panic() {
    let mut parser = Parser::new();
    // Walk every message type and object count over pseudo-random payloads, at every
    // length an extended header can still be read from.
    let mut state = 0x1234_5678u32;
    for round in 0..8000 {
        let len = 2 + round % 63;
        let mut bytes = Vec::with_capacity(len);
        for _ in 0..len {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            bytes.push((state >> 24) as u8);
        }
        // Half the rounds are forced extended, so the extended-header decoders get
        // random input rather than waiting on a chance bit.
        if round % 2 == 0 {
            bytes[1] |= 0x80;
        }
        let msg = parser.parse(&bytes, opts());
        assert!(!msg.field().is_empty());
    }
}

/// Rendering is recursive and `Metadata::new` is public, so a caller can build a tree
/// far deeper than any message. Descent stops rather than running the stack down.
#[test]
fn rendering_a_deeper_tree_than_any_message_is_bounded() {
    use usbpd_parser::{render, to_plain, Metadata, MAX_RENDER_DEPTH};

    let depth = MAX_RENDER_DEPTH * 3;
    let mut tree = Metadata::new("1", (0, 0), "Leaf", "bottom");
    for _ in 0..depth {
        tree = Metadata::new("1", (0, 0), "Nest", vec![tree]);
    }

    let text = to_plain(&render(&tree, 1));
    assert!(text.contains("nesting limit"), "descent was not bounded");
    // The limit is a depth, so it renders one node per level and then stops.
    assert_eq!(text.matches("Nest:").count(), MAX_RENDER_DEPTH + 1);
    assert!(!text.contains("Leaf:"), "descent reached the bottom");
}

/// Dropping such a tree is the other half of the same problem: `Value::List` makes
/// `Metadata` recursive, so the compiler's drop glue descends one frame per level.
#[test]
fn dropping_a_deeper_tree_than_any_message_does_not_run_the_stack_down() {
    use usbpd_parser::Metadata;

    // Deep enough that per-level drop glue would not fit in a small stack.
    let build = || {
        let mut tree = Metadata::new("1", (0, 0), "Leaf", "bottom");
        for _ in 0..200_000 {
            tree = Metadata::new("1", (0, 0), "Nest", vec![tree]);
        }
        drop(tree);
    };

    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(build)
        .unwrap()
        .join()
        .expect("dropping the tree overflowed the stack");
}
